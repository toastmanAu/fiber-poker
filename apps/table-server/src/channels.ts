/**
 * ChannelManager: one private bidirectional Fiber channel per seat
 * (public: false, one_way: false — docs/03).
 *
 * Player lifecycle:
 *   DISCONNECTED -> CONNECTED -> CHANNEL_NEGOTIATING -> CHANNEL_READY
 *     -> LIQUIDITY_CHECK -> SEAT_READY -> PLAYING
 *
 * CHANNEL_READY is necessary but NOT sufficient for SEAT_READY: liquidity
 * gating happens separately (LiquidityManager).
 */

import { classifyFundingAmount, type FiberGateway } from "@fiber-poker/fiber-adapter";

export type SeatLifecycle =
  | "DISCONNECTED"
  | "CONNECTED"
  | "CHANNEL_NEGOTIATING"
  | "CHANNEL_READY"
  | "LIQUIDITY_CHECK"
  | "SEAT_READY"
  | "PLAYING"
  | "LEAVE_PENDING"
  | "TOP_UP_QUEUED"
  | "CLOSING";

export class ChannelManager {
  private lifecycle = new Map<string, SeatLifecycle>();
  private channels = new Map<string, string>(); // playerId -> channelId
  /** channelId -> playerIds whose seat is backed by it. Several seats can
   *  share one channel (multiple agents behind one fiber node — docs/15);
   *  the underlying channel may only close when the LAST user leaves. */
  private channelUsers = new Map<string, Set<string>>();

  constructor(
    private readonly gateway: FiberGateway | null,
    private readonly fundingAmount: bigint,
    private readonly notify: (playerId: string, message: unknown) => void,
    /** Poker session key -> Fiber node pubkey (docs/15). Identity default. */
    private readonly resolvePeer: (playerId: string) => string = (id) => id,
  ) {}

  status(playerId: string): SeatLifecycle {
    return this.lifecycle.get(playerId) ?? "DISCONNECTED";
  }

  channelId(playerId: string): string | null {
    return this.channels.get(playerId) ?? null;
  }

  setLifecycle(playerId: string, state: SeatLifecycle): void {
    this.lifecycle.set(playerId, state);
    this.notify(playerId, {
      type: "SEAT_STATUS",
      payload: { lifecycle: state },
    });
  }

  /**
   * Ensure a ready channel exists for the player. Returns the channelId.
   * With no gateway (fake-settlement dev mode) this short-circuits to
   * CHANNEL_READY with a simulated id.
   */
  async ensureChannel(playerPubkey: string): Promise<string> {
    this.setLifecycle(playerPubkey, "CHANNEL_NEGOTIATING");
    if (!this.gateway) {
      const id = `simulated-channel-${playerPubkey.slice(0, 10)}`;
      this.channels.set(playerPubkey, id);
      this.setLifecycle(playerPubkey, "CHANNEL_READY");
      return id;
    }
    const peer = this.resolvePeer(playerPubkey);
    const existing = await this.gateway.channelTo?.(peer);
    let channelId: string;
    if (existing) {
      channelId = existing.channelId;
    } else {
      // P2 funding policy: hard-block useless opens, bump below-floor opens
      // to the peer's gossiped auto-accept minimum (an under-floor open is
      // pinned in NegotiatingFunding forever), and on a stalled open (the
      // gateway has already abandoned the ghost) retry exactly once.
      let amount = this.fundingAmount;
      let floor: bigint | undefined;
      try {
        floor = await this.gateway.peerAutoAcceptFloor?.(peer);
      } catch {
        /* gossip lookup is best-effort */
      }
      const verdict = classifyFundingAmount(amount, floor);
      if (verdict.verdict === "below-reserve") throw new Error(verdict.detail);
      if (verdict.verdict === "bumped-to-peer-floor") {
        amount = verdict.openAmount;
        this.notify(playerPubkey, {
          type: "CHANNEL_STATUS",
          payload: {
            channelId: null,
            state: "CHANNEL_NEGOTIATING",
            fundingBumpedFrom: verdict.requested.toString(),
            fundingBumpedTo: verdict.openAmount.toString(),
          },
        });
      }
      try {
        const opened = await this.gateway.openChannel(peer, amount);
        channelId = opened.channelId;
      } catch (e) {
        const stalled = e instanceof Error && e.name === "ChannelOpenStalledError";
        if (!stalled) throw e;
        // The ghost is gone; give the acceptor exactly one more chance.
        const retry = await this.gateway.openChannel(peer, amount);
        channelId = retry.channelId;
      }
    }
    this.channels.set(playerPubkey, channelId);
    const users = this.channelUsers.get(channelId) ?? new Set<string>();
    users.add(playerPubkey);
    this.channelUsers.set(channelId, users);
    this.setLifecycle(playerPubkey, "CHANNEL_READY");
    this.notify(playerPubkey, {
      type: "CHANNEL_STATUS",
      payload: { channelId, state: "CHANNEL_READY", isPublic: false, isOneWay: false },
    });
    return channelId;
  }

  /**
   * Re-register a seat's channel during crash recovery (the event log's
   * ChannelReady events carry {playerId, channelId}). Without this, a
   * restarted server pays out leaves but never closes the real channel —
   * its channel map is empty and shutdownChannel becomes a no-op.
   */
  restore(playerId: string, channelId: string): void {
    this.channels.set(playerId, channelId);
    const users = this.channelUsers.get(channelId) ?? new Set<string>();
    users.add(playerId);
    this.channelUsers.set(channelId, users);
    if (!this.lifecycle.has(playerId)) this.lifecycle.set(playerId, "CHANNEL_READY");
  }

  /**
   * Cooperative shutdown after final obligations (leave flow). With a shared
   * channel (several seats behind one fiber node) the last leaving seat is
   * the one that actually closes the underlying channel; earlier leaves only
   * drop their seat's mapping so remaining seats keep their payout path.
   */
  async shutdownChannel(playerPubkey: string): Promise<void> {
    this.setLifecycle(playerPubkey, "CLOSING");
    const channelId = this.channels.get(playerPubkey);
    this.channels.delete(playerPubkey);
    const users = channelId ? this.channelUsers.get(channelId) : undefined;
    if (users) {
      users.delete(playerPubkey);
      if (users.size === 0) this.channelUsers.delete(channelId!);
    }
    if (this.gateway && channelId && (!users || users.size === 0)) {
      try {
        await this.gateway.shutdownChannel(channelId);
      } catch (e) {
        // The seat's funds are already paid out — a failed cooperative
        // close must not eat the leave (it previously killed the
        // PLAYER_LEFT broadcast and left the close silently undone).
        // Surface the failure; an operator can force-close later.
        console.error(`[channels] cooperative shutdown of ${channelId.slice(0, 18)}… failed: ${String(e)}`);
        this.notify(playerPubkey, {
          type: "CHANNEL_STATUS",
          payload: { channelId, state: "CLOSE_FAILED", error: String(e) },
        });
        this.lifecycle.delete(playerPubkey);
        return;
      }
    }
    this.lifecycle.delete(playerPubkey);
    this.notify(playerPubkey, {
      type: "CHANNEL_STATUS",
      payload: { channelId: channelId ?? null, state: "CLOSED" },
    });
  }
}
