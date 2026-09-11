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

import type { FiberGateway } from "@fiber-poker/fiber-adapter";

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
      const opened = await this.gateway.openChannel(peer, this.fundingAmount);
      channelId = opened.channelId;
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
   * Cooperative shutdown after final obligations (leave flow). With a shared
   * channel (several seats behind one fiber node) the last leaving seat is
   * the one that actually closes the channel; earlier leaves only drop their
   * seat's mapping so remaining seats keep their payout path.
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
      await this.gateway.shutdownChannel(channelId);
    }
    this.lifecycle.delete(playerPubkey);
    this.notify(playerPubkey, {
      type: "CHANNEL_STATUS",
      payload: { channelId: channelId ?? null, state: "CLOSED" },
    });
  }
}
