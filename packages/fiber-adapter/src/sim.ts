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
export type SimInvoiceStatus = "Open" | "Received" | "Paid" | "Cancelled" | "Expired";

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
  /** Hold invoice: payer funds are received-but-not-settled until the payee
   *  settles (reveals the preimage) or cancels. */
  hold?: boolean;
  preimageHash?: string;
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
  /**
   * Commitment version: bumped on every agreed state update. A unilateral
   * close claiming an older version is a stale commitment and punishable
   * by the watchtower / counterparty.
   */
  version: number;
  /** Unilateral close pending on-chain settlement (matures as ticks pass). */
  pendingForceClose?: {
    closer: string;
    /** Settled at tick >= this. */
    maturesAtTick: number;
    toCloser: bigint;
    toCounterparty: bigint;
    punishable: boolean;
  };
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
  /** Watchtower-registered channels: channelId -> latest witnessed version. */
  private towerRegistry = new Map<string, number>();
  /** Closure records for force-close recovery tests. */
  private closures: { channelId: string; closer: string; mode: "cooperative" | "force" | "force-punished" }[] = [];

  /** The simulated watchtower: registers channels, witnesses updates. */
  get watchtower(): SimWatchtower {
    return new SimWatchtower(this);
  }

  /** Completed closures (recovery-path introspection for tests). */
  closureLog(): readonly { channelId: string; closer: string; mode: "cooperative" | "force" | "force-punished" }[] {
    return this.closures;
  }

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
      version: 1,
    };
    this.channels.push(ch);
    return ch.channelId;
  }

  createInvoice(
    node: string,
    amount: bigint,
    paymentHash?: string,
    opts?: { hold?: boolean; preimageHash?: string },
  ): { paymentHash: string } {
    this.assertOnline(node);
    const hash = paymentHash ?? toHex(ckbHash(new TextEncoder().encode(`inv-${node}-${++this.paymentCounter}`)));
    this.invoices.set(hash, {
      paymentHash: hash,
      to: node,
      amount,
      status: "Open",
      hold: opts?.hold ?? false,
      preimageHash: opts?.preimageHash,
    });
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
    if (inv.hold) {
      // Funds are locked in the channel toward the payee but NOT settled:
      // the invoice sits in "Received" until settle_invoice / cancel_invoice.
      inv.status = "Received";
      this.payments.set(`held:${paymentHash}`, {
        paymentHash,
        from: payer,
        to: inv.to,
        amount: inv.amount,
        status: "Inflight",
        latencyTicks: 0,
      });
    } else {
      inv.status = "Paid";
    }
  }

  /** Payee settles a held invoice by revealing the preimage. */
  settleInvoice(paymentHash: string, preimage: string): void {
    const inv = this.invoices.get(paymentHash);
    if (!inv) throw new Error(`unknown invoice ${paymentHash}`);
    if (inv.status !== "Received") throw new Error(`invoice not settleable from status ${inv.status}`);
    if (!inv.preimageHash) throw new Error("invoice is not a hold invoice");
    const digest = toHex(ckbHash(new TextEncoder().encode(preimage)));
    if (digest !== inv.preimageHash) throw new Error("preimage does not hash to the invoice payment hash");
    inv.status = "Paid";
    const held = this.payments.get(`held:${paymentHash}`);
    if (held) held.status = "Success";
  }

  /** Payee cancels a held (or open) invoice: funds return to the payer. */
  cancelInvoice(paymentHash: string): void {
    const inv = this.invoices.get(paymentHash);
    if (!inv) throw new Error(`unknown invoice ${paymentHash}`);
    if (inv.status !== "Open" && inv.status !== "Received") {
      throw new Error(`invoice not cancellable from status ${inv.status}`);
    }
    const wasReceived = inv.status === "Received";
    inv.status = "Cancelled";
    const held = this.payments.get(`held:${paymentHash}`);
    if (held && wasReceived) {
      held.status = "Failed";
      held.error = "hold invoice cancelled";
    }
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
    // Every agreed state update produces a new commitment version, which a
    // registered watchtower witnesses.
    ch.version += 1;
    this.witness(ch.channelId, ch.version);
  }

  private witness(channelId: string, version: number): void {
    if (this.towerRegistry.has(channelId)) {
      this.towerRegistry.set(channelId, Math.max(this.towerRegistry.get(channelId)!, version));
    }
  }

  paymentStatus(paymentHash: string): SimPayment {
    const p = this.payments.get(paymentHash) ?? this.payments.get(`held:${paymentHash}`);
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

  channelById(channelId: string): SimChannel | undefined {
    return this.channels.find((c) => c.channelId === channelId);
  }

  /** Current commitment version of a channel. */
  commitmentVersion(channelId: string): number {
    const ch = this.channelById(channelId);
    if (!ch) throw new Error(`unknown channel ${channelId}`);
    return ch.version;
  }

  /**
   * Cooperative close: both parties sign the final state; balances settle
   * immediately. `force` is unilateral: the closer broadcasts their latest
   * commitment and the counterparty's payout matures after
   * `delayTicks` ticks — unless the broadcast commitment is STALE
   * (`claimedVersion` below the live version), in which case the watchtower
   * punishes: the closer forfeits their entire channel balance.
   */
  shutdownChannel(channelId: string, opts: { force?: boolean; claimedVersion?: number; delayTicks?: number; closer?: string } = {}): void {
    const ch = this.channelById(channelId);
    if (!ch) throw new Error(`unknown channel ${channelId}`);
    if (ch.state !== "ChannelReady") throw new Error(`channel ${channelId} not closable from state ${ch.state}`);

    if (!opts.force) {
      ch.state = "Closed";
      this.closures.push({ channelId, closer: opts.closer ?? ch.nodeA, mode: "cooperative" });
      return;
    }

    const closer = opts.closer ?? ch.nodeA;
    const counterparty = closer === ch.nodeA ? ch.nodeB : ch.nodeA;
    const claimed = opts.claimedVersion ?? ch.version;
    const liveVersion = ch.version;

    if (claimed < liveVersion && this.towerRegistry.has(channelId)) {
      // Stale commitment broadcast: the watchtower (or counterparty)
      // punishes. The cheater forfeits their whole channel balance.
      const cheaterIsA = closer === ch.nodeA;
      const forfeit = cheaterIsA ? ch.balanceA : ch.balanceB;
      if (cheaterIsA) {
        ch.balanceB += ch.balanceA;
        ch.balanceA = 0n;
      } else {
        ch.balanceA += ch.balanceB;
        ch.balanceB = 0n;
      }
      void forfeit;
      ch.state = "Closed";
      this.closures.push({ channelId, closer, mode: "force-punished" });
      return;
    }

    // Honest unilateral close: closer's funds return immediately, the
    // counterparty's payout matures on-chain after the delay.
    const closerIsA = closer === ch.nodeA;
    ch.pendingForceClose = {
      closer,
      maturesAtTick: this.now + (opts.delayTicks ?? 2),
      toCloser: closerIsA ? ch.balanceA : ch.balanceB,
      toCounterparty: closerIsA ? ch.balanceB : ch.balanceA,
      punishable: false,
    };
    ch.state = "ShuttingDown";
    this.closures.push({ channelId, closer, mode: "force" });
  }

  /**
   * Move on-chain funds into one side of a channel — the simulator's
   * equivalent of accepting a channel with your own funding amount. Needed
   * for player->table payments when the table opened the channel.
   */
  fundChannelSide(channelId: string, node: string, amount: bigint): void {
    const ch = this.channelById(channelId);
    if (!ch) throw new Error(`unknown channel ${channelId}`);
    if (ch.state !== "ChannelReady") throw new Error(`channel ${channelId} not ready`);
    const n = this.nodes.get(node);
    if (!n) throw new Error(`unknown node ${node}`);
    if (n.balance < amount) throw new Error("insufficient on-chain balance to fund channel side");
    n.balance -= amount;
    if (ch.nodeA === node) ch.balanceA += amount;
    else ch.balanceB += amount;
    ch.version += 1;
    this.witness(channelId, ch.version);
  }

  /** Latest ChannelReady channel between a node and a peer. */
  channelBetweenNodes(a: string, b: string): { channelId: string } | undefined {
    const ch = this.channelBetween(a, b);
    return ch ? { channelId: ch.channelId } : undefined;
  }

  /** Test helper: push balances around without payments. */
  setChannelBalances(channelId: string, a: bigint, b: bigint): void {
    const ch = this.channelById(channelId);
    if (!ch) throw new Error(`unknown channel ${channelId}`);
    ch.balanceA = a;
    ch.balanceB = b;
    ch.version += 1;
    this.witness(channelId, ch.version);
  }

  /** Advance the simulated clock by one step (resolves latency, closes). */
  tick(): void {
    this.now += 1;
    for (const ch of this.channels) {
      const pending = ch.pendingForceClose;
      if (pending && this.now >= pending.maturesAtTick && ch.state === "ShuttingDown") {
        // Payouts from the last commitment settle on-chain.
        if (pending.toCloser > 0n) {
          const n = this.nodes.get(pending.closer);
          if (n) n.balance += pending.toCloser;
        }
        ch.state = "Closed";
        ch.pendingForceClose = undefined;
      }
    }
  }
}

/**
 * Simulated watchtower: registers channels, witnesses every commitment
 * update, and can report/punish stale unilateral closes.
 */
export class SimWatchtower {
  constructor(private readonly net: SimulatedFiberNetwork) {}

  /** Begin watching a channel from its current commitment version. */
  register(channelId: string): void {
    const ch = this.net.channelById(channelId);
    if (!ch) throw new Error(`unknown channel ${channelId}`);
    const current = this.net.commitmentVersion(channelId);
    const registered = this.net["towerRegistry"].get(channelId);
    this.net["towerRegistry"].set(channelId, Math.max(registered ?? 0, current));
  }

  /** Latest commitment version the tower has witnessed for a channel. */
  witnessedVersion(channelId: string): number {
    return this.net["towerRegistry"].get(channelId) ?? -1;
  }

  /**
   * True when the channel was closed with a commitment older than the one
   * the tower witnessed (the punish condition).
   */
  seesStaleClose(channelId: string): boolean {
    const log = this.net.closureLog();
    const last = [...log].reverse().find((c) => c.channelId === channelId);
    return last?.mode === "force-punished";
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

  async shutdownChannel(channelId: string, opts?: { force?: boolean; claimedVersion?: number; delayTicks?: number }): Promise<void> {
    this.net.shutdownChannel(channelId, { force: opts?.force ?? false, claimedVersion: opts?.claimedVersion, delayTicks: opts?.delayTicks, closer: this.pubkey });
  }

  /** Accept-side funding: move on-chain funds into this node's channel side. */
  async fundChannelTo(peerPubkey: string, amount: bigint): Promise<void> {
    const ch = this.net.channelsOf(this.pubkey).find((c) => c.nodeA === peerPubkey || c.nodeB === peerPubkey);
    if (!ch) throw new Error(`no channel to ${peerPubkey.slice(0, 8)}…`);
    this.net.fundChannelSide(ch.channelId, this.pubkey, amount);
  }

  /** Commitment version this node sees for its channel with `peerPubkey`. */
  async commitmentVersionTo(peerPubkey: string): Promise<number | undefined> {
    const ch = this.net.channelsOf(this.pubkey).find((c) => (c.nodeA === peerPubkey || c.nodeB === peerPubkey));
    return ch?.version;
  }

  /**
   * Unilateral close claiming a specific commitment version (a stale claim
   * is punishable when a watchtower has witnessed a newer one).
   */
  async forceCloseTo(peerPubkey: string, claimedVersion?: number): Promise<void> {
    const ch = this.net.channelsOf(this.pubkey).find((c) => (c.nodeA === peerPubkey || c.nodeB === peerPubkey));
    if (!ch) throw new Error(`no channel to ${peerPubkey.slice(0, 8)}…`);
    this.net.shutdownChannel(ch.channelId, { force: true, claimedVersion, closer: this.pubkey });
  }

  async createInvoice(amount: bigint, paymentHash?: string): Promise<{ paymentHash: string }> {
    return this.net.createInvoice(this.pubkey, amount, paymentHash);
  }

  async invoiceStatus(paymentHash: string): Promise<"Open" | "Received" | "Paid" | "Cancelled" | "Expired" | "Unknown"> {
    return this.net.invoiceStatus(paymentHash).status;
  }

  async createHoldInvoice(amount: bigint, preimageHash: string): Promise<{ paymentHash: string }> {
    return this.net.createInvoice(this.pubkey, amount, preimageHash, { hold: true, preimageHash });
  }

  async settleInvoice(paymentHash: string, preimage: string): Promise<void> {
    this.net.settleInvoice(paymentHash, preimage);
  }

  async cancelInvoice(paymentHash: string): Promise<void> {
    this.net.cancelInvoice(paymentHash);
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
