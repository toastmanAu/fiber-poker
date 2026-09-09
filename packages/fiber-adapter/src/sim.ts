/**
 * Simulated Fiber Network: an in-process, deterministic-when-idle stand-in
 * for a real FNN deployment. Implements the same narrow gateway interface as
 * the real adapter so table-server tests and CI run without devnet.
 *
 * Features the tests need: multi-node channels, balances, invoices,
 * keysend-style payments, latency, and fault injection (offline nodes,
 * insufficient balance, fail-next-payment).
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { ckbHash } from "@fiber-poker/protocol";
import { toHex } from "./hex.ts";
import type { FiberGateway } from "./gateway.ts";

export type SimPaymentStatus = "Created" | "Inflight" | "Success" | "Failed";
export type SimInvoiceStatus = "Open" | "Paid" | "Cancelled" | "Expired";

interface SimPayment {
  paymentHash: string;
  from: string;
  to: string;
  amount: bigint;
  status: SimPaymentStatus;
  error?: string;
  /** When > 0, the payment resolves after this many `tick()` calls. */
  latencyTicks: number;
}

interface SimInvoice {
  paymentHash: string;
  to: string;
  amount: bigint;
  status: SimInvoiceStatus;
}

interface SimChannel {
  channelId: string;
  nodeA: string; // initiator
  nodeB: string;
  state: "Negotiating" | "ChannelReady" | "ShuttingDown" | "Closed";
  balanceA: bigint;
  balanceB: bigint;
  public: boolean;
  oneWay: boolean;
}

export interface SimNodeConfig {
  pubkey: string;
  offline?: boolean;
  /** Startup liquidity (shannons). */
  balance: bigint;
}

export class SimulatedFiberNetwork {
  private nodes = new Map<string, SimNodeConfig & { privkey?: Uint8Array }>();
  private channels: SimChannel[] = [];
  private payments = new Map<string, SimPayment>();
  private invoices = new Map<string, SimInvoice>();
  private failNext = new Map<string, string>(); // nodePubkey -> error
  private channelCounter = 0;
  private paymentCounter = 0;
  /** Simulated clock for latency (advanced by tick()). */
  private now = 0;

  addNode(cfg: SimNodeConfig): this {
    this.nodes.set(cfg.pubkey, { ...cfg });
    return this;
  }

  /** Create n nodes with random pubkeys and equal balances. */
  addRandomNodes(n: number, balance: bigint): string[] {
    const pubkeys: string[] = [];
    for (let i = 0; i < n; i++) {
      const priv = secp256k1.utils.randomPrivateKey();
      const pub = secp256k1.getPublicKey(priv, true);
      const pubkey = toHex(pub);
      this.nodes.set(pubkey, { pubkey, balance });
      pubkeys.push(pubkey);
    }
    return pubkeys;
  }

  setOffline(pubkey: string, offline: boolean): this {
    const n = this.nodes.get(pubkey);
    if (n) n.offline = offline;
    return this;
  }

  failNextPaymentFrom(pubkey: string, error: string): this {
    this.failNext.set(pubkey, error);
    return this;
  }

  node(pubkey: string): SimNodeGateway {
    if (!this.nodes.has(pubkey)) throw new Error(`unknown sim node ${pubkey}`);
    return new SimNodeGateway(this, pubkey);
  }

  // --- internal mechanics (used by SimNodeGateway) --------------------------

  assertOnline(pubkey: string): void {
    const n = this.nodes.get(pubkey);
    if (!n) throw new Error(`unknown node ${pubkey}`);
    if (n.offline) throw new Error(`node ${pubkey.slice(0, 10)}… is offline`);
  }

  channelBetween(a: string, b: string): SimChannel | undefined {
    return this.channels.find(
      (c) => c.state === "ChannelReady" && ((c.nodeA === a && c.nodeB === b) || (c.nodeA === b && c.nodeB === a)),
    );
  }

  openChannel(initiator: string, peer: string, funding: bigint): string {
    this.assertOnline(initiator);
    this.assertOnline(peer);
    const n = this.nodes.get(initiator)!;
    if (n.balance < funding) throw new Error("insufficient on-chain balance to fund channel");
    n.balance -= funding;
    const ch: SimChannel = {
      channelId: `sim-ch-${++this.channelCounter}`,
      nodeA: initiator,
      nodeB: peer,
      state: "ChannelReady", // devnet-style: open is immediate in the simulator
      balanceA: funding,
      balanceB: 0n,
      public: false,
      oneWay: false,
    };
    this.channels.push(ch);
    return ch.channelId;
  }

  createInvoice(node: string, amount: bigint, paymentHash?: string): { paymentHash: string } {
    this.assertOnline(node);
    const hash = paymentHash ?? toHex(ckbHash(new TextEncoder().encode(`inv-${node}-${++this.paymentCounter}`)));
    this.invoices.set(hash, { paymentHash: hash, to: node, amount, status: "Open" });
    return { paymentHash: hash };
  }

  payInvoice(payer: string, paymentHash: string): void {
    this.assertOnline(payer);
    const inv = this.invoices.get(paymentHash);
    if (!inv) throw new Error(`unknown invoice ${paymentHash}`);
    if (inv.status !== "Open") throw new Error(`invoice not payable (status ${inv.status})`);
    const ch = this.channelBetween(payer, inv.to);
    if (!ch) throw new Error(`no channel between ${payer.slice(0, 8)}… and ${inv.to.slice(0, 8)}…`);
    this.route(payer, inv.to, ch, inv.amount);
    inv.status = "Paid";
  }

  /** Keysend-style direct payment with a sender-chosen payment hash. */
  sendDirect(payer: string, target: string, amount: bigint, paymentHash: string): void {
    this.assertOnline(payer);
    this.assertOnline(target);
    const injected = this.failNext.get(payer);
    if (injected) {
      this.failNext.delete(payer);
      this.payments.set(paymentHash, { paymentHash, from: payer, to: target, amount, status: "Failed", error: injected, latencyTicks: 0 });
      return;
    }
    const ch = this.channelBetween(payer, target);
    if (!ch) throw new Error(`no channel between ${payer.slice(0, 8)}… and ${target.slice(0, 8)}…`);
    try {
      this.route(payer, target, ch, amount);
      this.payments.set(paymentHash, { paymentHash, from: payer, to: target, amount, status: "Success", latencyTicks: 0 });
    } catch (e) {
      this.payments.set(paymentHash, {
        paymentHash,
        from: payer,
        to: target,
        amount,
        status: "Failed",
        error: e instanceof Error ? e.message : String(e),
        latencyTicks: 0,
      });
    }
  }

  /** Move `amount` from `from` to `to` across an existing channel. */
  private route(from: string, to: string, ch: SimChannel, amount: bigint): void {
    const fromIsA = ch.nodeA === from;
    const fromBalance = fromIsA ? ch.balanceA : ch.balanceB;
    const toBalance = fromIsA ? ch.balanceB : ch.balanceA;
    if (fromBalance < amount) {
      throw new Error(`insufficient channel liquidity (${fromBalance} < ${amount})`);
    }
    if (fromIsA) {
      ch.balanceA -= amount;
      ch.balanceB += amount;
    } else {
      ch.balanceB -= amount;
      ch.balanceA += amount;
    }
    void toBalance;
  }

  paymentStatus(paymentHash: string): SimPayment {
    const p = this.payments.get(paymentHash);
    if (!p) throw new Error(`unknown payment ${paymentHash}`);
    return p;
  }

  invoiceStatus(paymentHash: string): SimInvoice {
    const inv = this.invoices.get(paymentHash);
    if (!inv) throw new Error(`unknown invoice ${paymentHash}`);
    return inv;
  }

  channelsOf(pubkey: string): SimChannel[] {
    return this.channels.filter((c) => (c.nodeA === pubkey || c.nodeB === pubkey) && c.state !== "Closed");
  }

  shutdownChannel(channelId: string, force = false): void {
    const ch = this.channels.find((c) => c.channelId === channelId);
    if (!ch) throw new Error(`unknown channel ${channelId}`);
    if (force) {
      ch.state = "Closed";
    } else {
      ch.state = "Closed"; // simulator: cooperative shutdown is immediate
    }
  }

  /** Test helper: push balances around without payments. */
  setChannelBalances(channelId: string, a: bigint, b: bigint): void {
    const ch = this.channels.find((c) => c.channelId === channelId);
    if (!ch) throw new Error(`unknown channel ${channelId}`);
    ch.balanceA = a;
    ch.balanceB = b;
  }

  /** Advance the simulated clock by one step (resolves latency). */
  tick(): void {
    this.now += 1;
  }
}

/**
 * Per-node view over the simulated network. Implements the same narrow
 * interface as the real FiberGateway.
 */
export class SimNodeGateway implements FiberGateway {
  constructor(
    private readonly net: SimulatedFiberNetwork,
    private readonly pubkey: string,
  ) {}

  async nodePubkey(): Promise<string> {
    this.net.assertOnline(this.pubkey);
    return this.pubkey;
  }

  async connectPeer(_address: string): Promise<void> {
    /* simulator: peers are implicitly connected */
  }

  async openChannel(peerPubkey: string, fundingAmount: bigint): Promise<{ channelId: string }> {
    const channelId = this.net.openChannel(this.pubkey, peerPubkey, fundingAmount);
    return { channelId };
  }

  async listChannels(): Promise<import("./gateway.ts").GatewayChannel[]> {
    this.net.assertOnline(this.pubkey);
    return this.net.channelsOf(this.pubkey).map((c) => {
      const isA = c.nodeA === this.pubkey;
      return {
        channelId: c.channelId,
        peerPubkey: isA ? c.nodeB : c.nodeA,
        stateName: c.state,
        localBalance: isA ? c.balanceA : c.balanceB,
        remoteBalance: isA ? c.balanceB : c.balanceA,
        offeredTlcBalance: 0n,
        receivedTlcBalance: 0n,
        isPublic: c.public,
        isOneWay: c.oneWay,
      };
    });
  }

  async channelTo(peerPubkey: string): Promise<import("./gateway.ts").GatewayChannel | undefined> {
    const all = await this.listChannels();
    return all.find((c) => c.peerPubkey === peerPubkey && c.stateName === "ChannelReady");
  }

  async shutdownChannel(channelId: string, opts?: { force?: boolean }): Promise<void> {
    this.net.shutdownChannel(channelId, opts?.force ?? false);
  }

  async createInvoice(amount: bigint, paymentHash?: string): Promise<{ paymentHash: string }> {
    return this.net.createInvoice(this.pubkey, amount, paymentHash);
  }

  async invoiceStatus(paymentHash: string): Promise<"Open" | "Paid" | "Cancelled" | "Expired" | "Unknown"> {
    return this.net.invoiceStatus(paymentHash).status;
  }

  /** The simulator marks direct payments terminal synchronously. */
  async sendToPeer(targetPubkey: string, amount: bigint, paymentHash?: string): Promise<{ paymentHash: string }> {
    const hash = paymentHash ?? toHex(ckbHash(new TextEncoder().encode(`pay-${this.pubkey}-${targetPubkey}-${amount}-${Math.random()}`)));
    this.net.sendDirect(this.pubkey, targetPubkey, amount, hash);
    return { paymentHash: hash };
  }

  async paymentStatus(paymentHash: string): Promise<SimPaymentStatus | "Unknown"> {
    const p = this.net.paymentStatus(paymentHash);
    return p.status;
  }
}
