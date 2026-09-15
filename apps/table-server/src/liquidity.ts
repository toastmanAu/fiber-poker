/**
 * LiquidityManager (docs/04): star-topology directional liquidity means
 * global table solvency is NOT enough — the table must hold outbound
 * capacity on EVERY player's channel before a hand starts, because a
 * winner is unknown until showdown.
 *
 * V0 conservative admission rule: before a hand, for every seated player,
 * guaranteed outbound capacity on that player's channel >= that player's
 * current stack. Oversized table-side funding is acceptable on devnet.
 */

import { ensureCapacity, type FiberGateway, type GatewayChannel } from "@fiber-poker/fiber-adapter";
import type { Shannon } from "@fiber-poker/poker-engine";

export interface PlayerLiquidity {
  playerId: string;
  channelId: string | null;
  localBalance: bigint; // table side: outbound to the player
  remoteBalance: bigint; // player side: their outbound to the table
  pendingOutgoing: bigint;
  usableOutbound: bigint;
}

export class LiquidityManager {
  private liquidity = new Map<string, PlayerLiquidity>();
  private paused = false;
  private pausedReason = "";

  constructor(
    private readonly gateway: FiberGateway | null,
    /** Poker session key -> Fiber node pubkey (docs/15). Identity default. */
    private readonly resolvePeer: (playerId: string) => string = (id) => id,
  ) {}

  /**
   * Refresh per-peer liquidity (keyed by PLAYER id). Multiple channels to
   * the same peer are AGGREGATED: payouts route through any of them, so a
   * split (e.g. 1 CKB + 385 CKB) must be summed, not last-channel-wins.
   */
  async refresh(players: { playerId: string }[]): Promise<void> {
    if (!this.gateway) return;
    const channels = await this.gateway.listChannels();
    const byPeer = new Map<string, GatewayChannel[]>();
    for (const c of channels) {
      if (c.stateName !== "ChannelReady") continue;
      const list = byPeer.get(c.peerPubkey) ?? [];
      list.push(c);
      byPeer.set(c.peerPubkey, list);
    }
    for (const p of players) {
      const peer = this.resolvePeer(p.playerId);
      const chans = byPeer.get(peer) ?? [];
      const local = chans.reduce((a, c) => a + c.localBalance, 0n);
      const remote = chans.reduce((a, c) => a + c.remoteBalance, 0n);
      const offered = chans.reduce((a, c) => a + c.offeredTlcBalance, 0n);
      const existing = this.liquidity.get(p.playerId);
      this.liquidity.set(p.playerId, {
        playerId: p.playerId,
        channelId: chans[0]?.channelId ?? existing?.channelId ?? null,
        localBalance: local,
        remoteBalance: remote,
        pendingOutgoing: offered,
        usableOutbound: local - offered,
      });
    }
  }

  /**
   * Pre-hand admission: every player's stack must be payable from table
   * outbound capacity on their own channel. `stacks` keyed by playerId.
   */
  canStartHand(stacks: Map<string, Shannon>): { ok: true } | { ok: false; reason: string } {
    if (this.paused) return { ok: false, reason: `hands paused: ${this.pausedReason}` };
    // Fake-settlement mode has no real directional liquidity to defend.
    if (!this.gateway) return { ok: true };
    for (const [playerId, stack] of stacks) {
      const lq = this.liquidity.get(playerId);
      if (!lq || !lq.channelId) {
        return { ok: false, reason: `no channel for ${short(playerId)}` };
      }
      if (lq.usableOutbound < stack) {
        return {
          ok: false,
          reason: `insufficient payout capacity to ${short(playerId)}: outbound ${lq.usableOutbound} < stack ${stack}`,
        };
      }
    }
    return { ok: true };
  }

  /**
   * Operator top-up: ensure `amount` of ADDITIONAL table-side payout
   * capacity toward the player. rc7 has no splice, so this opens a new
   * table-funded channel sized amount + occupied-capacity margin
   * (ensureCapacity), then refreshes the view.
   */
  async topUp(playerId: string, amount: bigint): Promise<void> {
    if (!this.gateway) return;
    const info = this.usableOutboundFor(playerId);
    if (!info) throw new Error(`no channel for ${short(playerId)}; cannot top up`);
    // occupied capacity on rc7 native-CKB channels is ~99 CKB per side.
    await ensureCapacity(this.gateway, info.peer, {
      min: info.usableOutbound + amount,
      openFunding: amount + 101n * 100_000_000n,
    });
    await this.refresh([{ playerId }]);
  }

  /**
   * Rebalancing abstraction point (circular self-payments land here in a
   * later milestone; V0 exposes the interface only).
   */
  async rebalance(targetPlayerId: string, amountShannons: bigint): Promise<void> {
    void targetPlayerId;
    void amountShannons;
    throw new Error("NOT_IMPLEMENTED: circular self-payment rebalancing is a future milestone (docs/04)");
  }

  /** Structured view for auto-capacity provisioning (P3 polish). */
  usableOutboundFor(playerId: string): { usableOutbound: bigint; peer: string } | undefined {
    const lq = this.liquidity.get(playerId);
    if (!lq) return undefined;
    return { usableOutbound: lq.usableOutbound, peer: this.resolvePeer(playerId) };
  }

  pause(reason: string): void {
    this.paused = true;
    this.pausedReason = reason;
  }

  resume(): void {
    this.paused = false;
    this.pausedReason = "";
  }

  snapshot(): PlayerLiquidity[] {
    return [...this.liquidity.values()];
  }
}

function short(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…`;
}
