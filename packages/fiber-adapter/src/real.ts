/**
 * Real gateway over an FNN v0.9.0 node via HTTP JSON-RPC.
 *
 * Channel opens are fire-and-poll: open_channel returns a temporary id; the
 * peer must accept; readiness is polled via list_channels until the channel
 * state_name is "ChannelReady".
 */

import { parseAmount } from "./hex.ts";
import { FiberRpcClient, type FiberChannel } from "./rpc.ts";
import type { FiberGateway, GatewayChannel } from "./gateway.ts";

export interface RealFiberGatewayOptions {
  url: string;
  authToken?: string;
  timeoutMs?: number;
  /** Default channel options for opens. */
  channelDefaults?: {
    public?: boolean;
    oneWay?: boolean;
    fundingAmount: bigint;
  };
}

function toGatewayChannel(c: FiberChannel): GatewayChannel {
  return {
    channelId: c.channel_id,
    peerPubkey: c.peer_pubkey,
    stateName: c.state_name,
    localBalance: parseAmount(c.local_balance),
    remoteBalance: parseAmount(c.remote_balance),
    offeredTlcBalance: parseAmount(c.offered_tlc_balance),
    receivedTlcBalance: parseAmount(c.received_tlc_balance),
    isPublic: Boolean(c.is_public),
    isOneWay: Boolean(c.is_one_way),
  };
}

export class RealFiberGateway implements FiberGateway {
  private readonly rpc: FiberRpcClient;
  private pubkeyCache?: string;

  constructor(private readonly opts: RealFiberGatewayOptions) {
    this.rpc = new FiberRpcClient({
      url: opts.url,
      authToken: opts.authToken,
      timeoutMs: opts.timeoutMs,
    });
  }

  async nodePubkey(): Promise<string> {
    if (!this.pubkeyCache) {
      const info = await this.rpc.nodeInfo();
      this.pubkeyCache = info.node_pubkey;
    }
    return this.pubkeyCache;
  }

  async connectPeer(address: string): Promise<void> {
    await this.rpc.connectPeer(address);
  }

  async openChannel(peerPubkey: string, fundingAmount: bigint): Promise<{ channelId: string }> {
    const defaults = this.opts.channelDefaults ?? { public: false, oneWay: false };
    const { temporary_channel_id } = await this.rpc.openChannel({
      peer_id: peerPubkey,
      funding_amount: fundingAmount,
      public: defaults.public ?? false,
      one_way: defaults.oneWay ?? false,
    });
    // The counterparty must accept for the channel to materialize. Real
    // deployments pair the table (accepting player opens) with players
    // opening; poll list_channels for the finalized id.
    const deadline = Date.now() + 120_000;
    for (;;) {
      const { channels } = await this.rpc.listChannels({});
      const mine = channels.find((c) => c.peer_pubkey === peerPubkey && c.state_name !== "Closed");
      if (mine) return { channelId: mine.channel_id };
      if (Date.now() > deadline) throw new Error(`channel with ${peerPubkey} did not finalize`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async listChannels(): Promise<GatewayChannel[]> {
    const { channels } = await this.rpc.listChannels({});
    return channels.map(toGatewayChannel);
  }

  async channelTo(peerPubkey: string): Promise<GatewayChannel | undefined> {
    const all = await this.listChannels();
    return all.find((c) => c.peerPubkey === peerPubkey && c.stateName === "ChannelReady");
  }

  async shutdownChannel(channelId: string, opts?: { force?: boolean }): Promise<void> {
    await this.rpc.shutdownChannel({ channel_id: channelId, force: opts?.force ?? false });
  }

  async createInvoice(amount: bigint, paymentHash?: string): Promise<{ paymentHash: string }> {
    const inv = await this.rpc.newInvoice({
      amount,
      ...(paymentHash ? { payment_hash: `0x${paymentHash.replace(/^0x/, "")}` } : {}),
    });
    return { paymentHash: inv.invoice.data.payment_hash };
  }

  async invoiceStatus(paymentHash: string): Promise<"Open" | "Received" | "Paid" | "Cancelled" | "Expired" | "Unknown"> {
    try {
      const inv = await this.rpc.getInvoice({ payment_hash: paymentHash });
      if (inv.status === "Paid" || inv.status === "Received" || inv.status === "Open" || inv.status === "Cancelled" || inv.status === "Expired") {
        return inv.status;
      }
      return "Unknown";
    } catch {
      return "Unknown";
    }
  }

  /**
   * Hold invoice: created with H(preimage) as its payment hash. Verify the
   * settle/cancel semantics against the pinned FNN build on devnet before
   * production use (docs/fnn-compat.md — settle_invoice / cancel_invoice).
   */
  async createHoldInvoice(amount: bigint, preimageHash: string): Promise<{ paymentHash: string }> {
    const inv = await this.rpc.newInvoice({
      amount,
      payment_hash: `0x${preimageHash.replace(/^0x/, "")}`,
    });
    return { paymentHash: inv.invoice.data.payment_hash };
  }

  async settleInvoice(paymentHash: string, preimage: string): Promise<void> {
    await this.rpc.settleInvoice({ payment_hash: paymentHash, payment_preimage: `0x${Buffer.from(preimage).toString("hex")}` });
  }

  async cancelInvoice(paymentHash: string): Promise<void> {
    await this.rpc.cancelInvoice({ payment_hash: paymentHash });
  }

  async sendToPeer(targetPubkey: string, amount: bigint, paymentHash?: string): Promise<{ paymentHash: string }> {
    const res = await this.rpc.sendPayment({
      target_pubkey: targetPubkey,
      amount,
      payment_hash: paymentHash,
    });
    return { paymentHash: res.payment_hash };
  }

  async paymentStatus(paymentHash: string): Promise<"Created" | "Inflight" | "Success" | "Failed" | "Unknown"> {
    const p = await this.rpc.getPayment({ payment_hash: paymentHash });
    return p.status;
  }
}
