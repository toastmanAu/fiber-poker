/**
 * Real gateway over an FNN v0.9.0 node via HTTP JSON-RPC.
 *
 * Channel opens are fire-and-poll: open_channel returns a temporary id; the
 * peer must accept; readiness is polled via list_channels until the channel
 * state_name is "ChannelReady".
 */

import { parseAmount, toHex } from "./hex.ts";
import { ckbHash } from "@fiber-poker/protocol";

function random32Hex(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toHex(b);
}
import { FiberRpcClient, type FiberChannel } from "./rpc.ts";
import type { FiberGateway, GatewayChannel } from "./gateway.ts";

export interface RealFiberGatewayOptions {
  url: string;
  authToken?: string;
  timeoutMs?: number;
  /** Invoice currency — rc7 requires it (Fibt = testnet, Fibd = devnet). */
  currency?: "Fibb" | "Fibt" | "Fibd";
  /** Default channel options for opens. */
  channelDefaults?: {
    public?: boolean;
    oneWay?: boolean;
    fundingAmount: bigint;
    /** Live-verified: fnn's default 1000 underpays cycle-heavy funding txs
     *  and they get rejected after broadcast, destroying the channel. */
    fundingFeeRate?: bigint;
  };
}

function toGatewayChannel(c: FiberChannel): GatewayChannel {
  return {
    channelId: c.channel_id,
    peerPubkey: c.pubkey,
    stateName: c.state.state_name,
    localBalance: parseAmount(c.local_balance),
    remoteBalance: parseAmount(c.remote_balance),
    offeredTlcBalance: parseAmount(c.offered_tlc_balance),
    receivedTlcBalance: parseAmount(c.received_tlc_balance),
    isPublic: Boolean(c.is_public),
    isOneWay: Boolean(c.is_one_way),
  };
}

/** Typed failure for an open that rc7 pinned in NegotiatingFunding (the
 *  ghost has been abandoned already); callers may retry once. */
export class ChannelOpenStalledError extends Error {
  constructor(readonly peerPubkey: string, readonly channelId: string) {
    super(`channel open to ${peerPubkey.slice(0, 16)}… stalled in NegotiatingFunding; abandoned ${channelId.slice(0, 18)}…`);
    this.name = "ChannelOpenStalledError";
  }
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
      this.pubkeyCache = info.pubkey;
    }
    return this.pubkeyCache;
  }

  async connectPeer(address: string): Promise<void> {
    await this.rpc.connectPeer(address);
  }

  async openChannel(peerPubkey: string, fundingAmount: bigint): Promise<{ channelId: string }> {
    const defaults = this.opts.channelDefaults ?? { public: false, oneWay: false };
    // Hard floor (see open-channel-defaults.ts): under the 99 CKB initiator
    // reserve the channel could never spend. (Below the PEER's floor the
    // ChannelManager bumps the amount BEFORE calling this — see
    // classifyFundingAmount; a peer-floor stall here gets abandoned.)
    if (fundingAmount < 100n * 100_000_000n) {
      throw new Error("funding below 100 CKB: no spendable balance and peers auto-accept floor blocks it");
    }
    // Snapshot BEFORE the open: the poll below must return the NEW
    // channel, never a pre-existing one to the same peer (live-verified
    // footgun: returning an old channel silently force-closes/deletes the
    // wrong channel downstream).
    const beforeIds = new Set((await this.rpc.listChannels({})).channels.map((c) => c.channel_id));
    const { temporary_channel_id } = await this.rpc.openChannel({
      peer_id: peerPubkey,
      pubkey: peerPubkey, // rc7 requires both fields
      funding_amount: fundingAmount,
      funding_fee_rate: this.opts.channelDefaults?.fundingFeeRate ?? 20_000n, // live-verified: fnn default 1000 underpays
      public: defaults.public ?? false,
      one_way: defaults.oneWay ?? false,
    });
    void temporary_channel_id;
    // The counterparty must accept for the channel to materialize. Poll
    // list_channels for the finalized id (live rc7 entry shape: peer field
    // `pubkey`, nested `state.state_name`).
    const deadline = Date.now() + 120_000;
    for (;;) {
      const { channels } = await this.rpc.listChannels({});
      const mine = channels.find(
        (c) => c.pubkey === peerPubkey && c.state.state_name !== "Closed" && !beforeIds.has(c.channel_id),
      );
      if (mine) return { channelId: mine.channel_id };
      if (Date.now() > deadline) {
        // Stalled open (rc7 pins below-floor or underfunded-acceptor opens
        // in NegotiatingFunding forever, with no rejection): abandon the
        // ghost so nothing pins, then fail with a typed error the caller
        // can retry on. Only RECENT pending channels are candidates —
        // ancient NegotiatingFunding ghosts from earlier sessions are
        // inert residue, not ours to kill (created_at is 0x-hex millis).
        const cutoff = Date.now() - 10 * 60_000;
        try {
          const pending = await this.rpc.listChannels({ only_pending: true });
          const stuck = pending.channels
            .filter(
              (c) =>
                c.pubkey === peerPubkey &&
                c.state.state_name === "NegotiatingFunding" &&
                Number.parseInt(c.created_at ?? "0x0", 16) >= cutoff,
            )
            .sort((a, b) => Number.parseInt(b.created_at ?? "0x0", 16) - Number.parseInt(a.created_at ?? "0x0", 16))[0];
          if (stuck) {
            await this.rpc.abandonChannel({ channel_id: stuck.channel_id }).catch(() => undefined);
            throw new ChannelOpenStalledError(peerPubkey, stuck.channel_id);
          }
        } catch (e) {
          if (e instanceof ChannelOpenStalledError) throw e;
          // fall through to the generic failure
        }
        throw new Error(`channel with ${peerPubkey} did not finalize`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** P2: the peer's gossiped auto-accept minimum (best-effort, bounded). */
  async peerAutoAcceptFloor(peerPubkey: string): Promise<bigint | undefined> {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.rpc.listGraphNodes(cursor ? { last_cursor: cursor } : {});
      const mine = res.nodes.find((n) => n.pubkey === peerPubkey);
      if (mine?.auto_accept_min_ckb_funding_amount !== undefined) {
        return parseAmount(mine.auto_accept_min_ckb_funding_amount);
      }
      if (!res.last_cursor || res.last_cursor === cursor) return undefined;
      cursor = res.last_cursor;
    }
    return undefined;
  }

  async abandonChannel(channelId: string): Promise<void> {
    await this.rpc.abandonChannel({ channel_id: channelId });
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

  /**
   * rc7-verified flow (2026-09-10 live node): the invoice MUST be created
   * from the payee's own `payment_preimage` — a payment_hash-only invoice
   * can never be settled (the payee lacks the preimage) and sits at
   * `Received` until cancelled. fnn auto-settles a preimage invoice when
   * the TLC arrives, so this is the immediate-settlement primitive.
   */
  async createInvoice(amount: bigint): Promise<{ paymentHash: string; invoiceAddress: string }> {
    const preimage = random32Hex();
    const inv = await this.rpc.newInvoice({
      amount,
      currency: this.opts.currency ?? "Fibt",
      payment_preimage: preimage,
    });
    return { paymentHash: inv.invoice.data.payment_hash, invoiceAddress: inv.invoice_address };
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
   * TRUE rc7 hold form (live-verified 2026-09-11): create from
   * `payment_hash` ONLY, where hash = CKB blake2b-256 of the preimage
   * bytes. The payer's TLC then parks the invoice at `Received` (funds
   * locked, NOT final) until settleInvoice reveals the preimage.
   * A preimage-bearing creation would AUTO-SETTLE on TLC arrival — which
   * is the immediate primitive, not a hold.
   */
  async createHoldInvoice(amount: bigint, preimage: string): Promise<{ paymentHash: string; invoiceAddress: string }> {
    const hex = preimage.startsWith("0x") ? preimage.slice(2) : preimage;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const paymentHash = `0x${toHex(ckbHash(bytes))}`;
    const inv = await this.rpc.newInvoice({
      amount,
      currency: this.opts.currency ?? "Fibt",
      payment_hash: paymentHash,
    });
    return { paymentHash: inv.invoice.data.payment_hash, invoiceAddress: inv.invoice_address };
  }

  async settleInvoice(paymentHash: string, preimage: string): Promise<void> {
    // Wire shape live-verified 2026-09-11: `0x`-prefixed hex vector of the
    // preimage bytes; the settle is accepted synchronously and the invoice
    // flips `Received -> Paid` asynchronously (observed within ~3-9 s).
    const hex = preimage.startsWith("0x") ? preimage : `0x${preimage}`;
    await this.rpc.settleInvoice({ payment_hash: paymentHash, payment_preimage: hex });
  }

  async cancelInvoice(paymentHash: string): Promise<void> {
    await this.rpc.cancelInvoice({ payment_hash: paymentHash });
  }

  async sendToPeer(targetPubkey: string, amount: bigint, paymentHash?: string): Promise<{ paymentHash: string }> {
    // Keysend: no invoice needed on the recipient side (payouts).
    // rc7 FORBIDS a payer-supplied payment_hash on keysend
    // ("keysend payment should not have payment_hash", InvalidParameter —
    // verified live 2026-09-11). The RESPONSE hash is the only correlation
    // handle; callers must poll THAT, not a precomputed hash.
    void paymentHash;
    const res = await this.rpc.sendPayment({
      target_pubkey: targetPubkey,
      amount,
      keysend: true,
    });
    return { paymentHash: res.payment_hash };
  }

  async payInvoice(invoice: string): Promise<{ paymentHash: string }> {
    const res = await this.rpc.sendPayment({ invoice });
    return { paymentHash: res.payment_hash };
  }

  async paymentStatus(paymentHash: string): Promise<"Created" | "Inflight" | "Success" | "Failed" | "Unknown"> {
    const p = await this.rpc.getPayment({ payment_hash: paymentHash });
    return p.status;
  }
}
