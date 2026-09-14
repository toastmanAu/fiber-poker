/**
 * TableServer: authoritative poker coordinator.
 *
 * Trust statement (docs/07): this server is authoritative for action
 * ordering, dealing, and settlement decisions. It is auditable through the
 * deterministic engine, signed hash-chained commits, and deck
 * commitment/reveal — it is NOT trustless. UI copy must not claim otherwise.
 *
 * Iron rule enforced here: a value-changing action commits ONLY after its
 * settlement obligation reached SUCCEEDED (payment-before-commit).
 */

import { WebSocket, WebSocketServer } from "ws";
import { MultiPartySeedDeck, ServerCommitRevealDeck, type DeckService } from "@fiber-poker/deck";
import type { EventStore, SnapshotStore } from "@fiber-poker/persistence";
import {
  FiberPokerEngine,
  type EconomicObligation,
  type PokerAction,
  type TableConfig,
  type TableState,
} from "@fiber-poker/poker-engine";
import {
  type ActionEnvelope,
  actionHash,
  createChallenge,
  type PublicTableState,
  makeMessage,
  publicView,
  verifyChallengeResponse,
  verifyEnvelopeSignature,
  type SeatStatus,
} from "@fiber-poker/protocol";
import { FakeSettlementAdapter, HoldInvoiceSettlement, ImmediateFiberSettlement, type SettlementAdapter } from "@fiber-poker/settlement";
import type { FiberGateway } from "@fiber-poker/fiber-adapter";
import { ChannelManager, type SeatLifecycle } from "./channels.ts";
import { SettlementCoordinator } from "./coordinator.ts";
import { LiquidityManager } from "./liquidity.ts";
import { RecoveryManager, genesisRuntime } from "./recovery.ts";
import { TableRuntime, type ChainTip, type StateCommitMessage } from "./runtime.ts";
import { RateLimiter, SessionManager, type Session } from "./sessions.ts";
import { loadConfig, loadOrCreateServerKeys, type TableServerConfig } from "./config.ts";
import { serializeBigints, serializeState } from "./serde.ts";

export interface TableServerOverrides {
  gateway?: FiberGateway | null;
  adapter?: SettlementAdapter;
  deck?: DeckService;
  events?: EventStore;
  snapshots?: SnapshotStore;
  keys?: { privateKey: string; publicKey: string };
}

interface SeatRecord {
  playerId: string;
  seat: number;
  sittingOut: boolean;
  connected: boolean;
  lifecycle?: string;
}

export interface CommitEventResult {
  commit: StateCommitMessage;
  state: TableState;
  obligations: EconomicObligation[];
  summary: string;
  eventId: string;
}

export class TableServer {
  readonly config: TableServerConfig;
  readonly tableConfig: TableConfig;
  readonly engine = new FiberPokerEngine();
  readonly sessions = new SessionManager();
  readonly limiter: RateLimiter;
  deck: DeckService;
  readonly adapter: SettlementAdapter;
  readonly events: EventStore;
  readonly snapshots: SnapshotStore;
  readonly gateway: FiberGateway | null;
  readonly channels: ChannelManager;
  readonly liquidity: LiquidityManager;
  readonly coordinator: SettlementCoordinator;
  runtime!: TableRuntime;

  private wss: WebSocketServer | null = null;
  private seats = new Map<string, SeatRecord>();
  private leaveQueue = new Set<string>();
  /** playerId -> accumulated top-up shannons awaiting a between-hands window. */
  private topupQueue = new Map<string, bigint>();
  private joinQueue: { playerId: string; seat: number; buyIn: bigint; channelId: string }[] = [];
  private usedNonces = new Set<string>();
  private turnTimers = new Map<string, NodeJS.Timeout>();
  /** Deadline of the currently armed turn so a reconnecting player can be
   *  re-notified WITHOUT extending the timer (RESYNC replay, item 5). */
  private currentTurnDeadline?: { key: string; deadlineUnixMs: number };
  private pendingPayments = new Map<string, { obligationIds: string[] }>();
  private reveals = new Map<string, unknown>();
  private commitCount = 0;
  private lastEventId = "";
  private currentHandId?: string;
  private lastCompletedHandId?: string;
  private recovering = true;
  /** Players whose channel closed unexpectedly; seat blocked until resolved. */
  private blockedSeats = new Set<string>();
  private monitorTimer: NodeJS.Timeout | null = null;
  /** Latest state acknowledgement per player (dispute evidence). */
  private acks = new Map<string, { sequence: string; stateHash: string; at: string }>();
  /** Poker session pubkey -> Fiber node pubkey (docs/15). */
  private peerMap = new Map<string, string>();
  /** Reads the LIVE map so late-registered declarations apply everywhere. */
  private resolvePeer = (playerId: string): string => this.peerMap.get(playerId) ?? playerId;
  /** P10 multiparty seed protocol state (null when idle / server deck). */
  private seedProtocol: { handId: string; stage: "commit" | "reveal" } | null = null;
  /** Players sat out by the seed anti-abort policy this hand. */
  private seedSatOut = new Set<string>();
  private seedTimers: NodeJS.Timeout[] = [];
  private startingHand = false;
  private exclusive: Promise<void> = Promise.resolve();
  private overrides: TableServerOverrides;
  private notify: (playerId: string, message: unknown) => void;
  private notificationLog: { playerId: string; message: Record<string, unknown> }[] = [];

  constructor(cfgOverrides: Partial<TableServerConfig> = {}, overrides: TableServerOverrides = {}) {
    this.config = loadConfig(cfgOverrides);
    this.tableConfig = {
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      maxSeats: this.config.maxSeats,
    };
    this.overrides = overrides;
    this.limiter = new RateLimiter(this.config.rateLimitPerSecond);
    this.deck = overrides.deck ?? new ServerCommitRevealDeck(); // replaced in start() for multiparty mode
    this.gateway = overrides.gateway !== undefined ? overrides.gateway : null;
    this.events = overrides.events!;
    this.snapshots = overrides.snapshots!;
    this.adapter = overrides.adapter ?? new FakeSettlementAdapter();

    this.notify = (playerId, raw: unknown) => {
      const body = raw as { type?: string; payload?: unknown };
      const msg = makeMessage(String(body.type ?? "ERROR"), body.payload ?? {}) as unknown as Record<string, unknown>;

      this.notificationLog.push({ playerId, message: msg });
      if (this.notificationLog.length > 5000) this.notificationLog.shift();
      const session = this.sessions.getByPlayer(playerId);
      if (session && session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(JSON.stringify(serializeBigints(msg)));
      }
    };

    // docs/15 topology: a player's fiber node key differs from their poker
    // session key. The peer map bridges them; identity by default.
    for (const [k, v] of Object.entries(JSON.parse(this.config.peerMapJson ?? "{}") as Record<string, string>)) {
      this.peerMap.set(k, v);
    }
    this.channels = new ChannelManager(this.gateway, this.config.channelFunding, this.notify, this.resolvePeer);
    this.liquidity = new LiquidityManager(this.gateway, this.resolvePeer);
    this.coordinator = new SettlementCoordinator(this.adapter, this.events, this.notify, {
      // Hold mode: actions commit on HELD liquidity; hand end settles.
      holdMode: this.adapter.constructor.name === "HoldInvoiceSettlement",
      awaitTimeoutMs: this.config.settlementTimeoutMs,
    });
    // Adapter-level peer resolution (payout legs): bind to the live map so
    // declared peers apply to payouts too. Both fiber adapters expose a
    // mutable resolvePeer (docs/15: session key != fiber node key).
    if (
      this.adapter instanceof ImmediateFiberSettlement ||
      this.adapter instanceof HoldInvoiceSettlement
    ) {
      this.adapter.resolvePeer = (playerId: string) => this.peerMap.get(playerId) ?? playerId;
    }
    this.coordinator.setTableId(this.config.tableId);
    if (this.adapter instanceof FakeSettlementAdapter) {
      this.adapter.autoPayPlayerPayments = this.config.autoPay;
    }
  }

  /** Serialize all state mutations through one promise chain. */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.exclusive.then(fn, fn);
    this.exclusive = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  notificationLogFor(playerId: string): Record<string, unknown>[] {
    return this.notificationLog.filter((n) => n.playerId === playerId).map((n) => n.message);
  }

  seatRecords(): SeatRecord[] {
    return [...this.seats.values()];
  }

  seatStatuses(): SeatStatus[] {
    return [...this.seats.values()].map((s) => ({
      playerId: s.playerId,
      seat: s.seat,
      lifecycle: "PLAYING",
      connected: s.connected,
      sittingOut: s.sittingOut,
    }));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const keys = this.overrides.keys ?? loadOrCreateServerKeys(this.config.dataDir);
    if (!this.overrides.deck && this.config.deck === "multiparty-seed") {
      this.deck = new MultiPartySeedDeck(keys.publicKey);
    }
    const genesis = genesisRuntime(this.config.tableId, this.tableConfig);
    this.runtime = new TableRuntime(this.events, keys.privateKey, keys.publicKey, genesis.state, genesis.tip);

    const recovery = new RecoveryManager(
      this.events,
      this.snapshots,
      this.coordinator,
      this.gateway,
      this.resolvePeer,
    );
    const result = await recovery.recover(this.runtime, this.tableConfig, (t) => {
      const remaining = t.deadlineUnixMs - Date.now();
      if (remaining > 0) {
        this.armTurnTimer(t.handId, t.sequence, t.actingSeat, remaining);
      } else {
        void this.runExclusive(() => this.resolveTimeout(t.actingSeat));
      }
    }, (playerId, channelId) => this.channels.restore(playerId, channelId));
    // Rebuild ack bookkeeping + last event id from the log.
    const allEvents = await this.events.readAll();
    for (const event of allEvents) {
      if (event.eventType === "StateAckRecorded") {
        const p = event.payload as { playerId: string; stateHash: string };
        this.acks.set(p.playerId, {
          sequence: event.sequence ?? "0",
          stateHash: p.stateHash,
          at: event.createdAt,
        });
      }
    }
    this.lastEventId = allEvents.at(-1)?.eventId ?? "";

    // Rebuild the in-memory seat map from the recovered engine state; seats
    // recover as unconnected until their player re-authenticates.
    for (const s of this.runtime.state.seats) {
      if (s.playerId !== null) {
        this.seats.set(s.playerId, { playerId: s.playerId, seat: s.seat, sittingOut: s.sittingOut, connected: false });
      }
    }
    this.recovering = false;

    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.config.port, host: this.config.host });
      wss.on("listening", resolve);
      wss.on("error", reject);
      wss.on("connection", (socket) => this.onConnection(socket));
      this.wss = wss;
    });
    // Force-close monitoring: a peer may unilaterally close at any time
    // (docs/07: block seat reuse until closure state is resolved).
    if (this.gateway) {
      this.monitorTimer = setInterval(() => {
        void this.runExclusive(() => this.checkChannelClosures());
      }, 10_000);
      this.monitorTimer.unref?.();
    }
    if (this.config.autoStartHands) {
      void this.runExclusive(() => this.maybeStartHand());
    }
    void result;
  }

  /**
   * Force-close recovery: observe unexpected channel closures, block the
   * affected seats, and pause hands. Recovery is explicit (resolveClosure).
   */
  blockedSeatIds(): string[] {
    return [...this.blockedSeats];
  }

  async checkChannelClosures(): Promise<string[]> {
    if (!this.gateway) return [];
    const closed: string[] = [];
    const channels = await this.gateway.listChannels();
    const readyPeers = new Set(channels.filter((c) => c.stateName === "ChannelReady").map((c) => c.peerPubkey));
    const closingPeers = new Set(channels.filter((c) => c.stateName !== "ChannelReady" && c.stateName !== "Closed").map((c) => c.peerPubkey));
    for (const record of this.seats.values()) {
      if (this.blockedSeats.has(record.playerId)) continue;
      const peer = this.resolvePeer(record.playerId);
      if (!readyPeers.has(peer) && !closingPeers.has(peer)) {
        // The player's channel vanished without a cooperative leave flow:
        // treat as force-closed until an operator resolves it.
        this.blockedSeats.add(record.playerId);
        record.lifecycle = "BLOCKED_CLOSURE" as SeatLifecycle;
        this.liquidity.pause(`force-close detected: ${record.playerId.slice(0, 8)}…`);
        closed.push(record.playerId);
        await this.events.append({
          tableId: this.config.tableId,
          handId: null,
          sequence: null,
          eventType: "ChannelClosed",
          createdAt: new Date().toISOString(),
          payload: { playerId: record.playerId, mode: "force-closed-observed" },
          fiberRef: null,
        });
        this.broadcast(makeMessage("SEAT_STATUS", {
          playerId: record.playerId,
          lifecycle: "BLOCKED_CLOSURE",
          connected: record.connected,
        }));
      }
    }
    return closed;
  }

  /**
   * Operator recovery path: re-establish the channel for a blocked seat and
   * resume hands when no blocks remain.
   */
  async resolveClosure(playerId: string): Promise<{ resolved: boolean; reason?: string }> {
    if (!this.blockedSeats.has(playerId)) return { resolved: false, reason: "not blocked" };
    if (!this.gateway) {
      this.blockedSeats.delete(playerId);
      this.liquidity.resume();
      return { resolved: true };
    }
    try {
      await this.channels.ensureChannel(playerId);
    } catch (e) {
      return { resolved: false, reason: String(e) };
    }
    this.blockedSeats.delete(playerId);
    if (this.blockedSeats.size === 0) this.liquidity.resume();
    this.broadcast(makeMessage("SEAT_STATUS", { playerId, lifecycle: "SEAT_READY" }));
    return { resolved: true };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.turnTimers.values()) clearTimeout(t);
    this.turnTimers.clear();
    this.clearSeedTimers();
    // Terminate client sockets so close() does not wait on them.
    for (const session of this.sessions.onlineSessions()) {
      session.socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      if (this.wss) this.wss.close((err) => (err ? reject(err) : resolve()));
      else resolve();
    });
    await this.events.close();
  }

  private stopped = false;

  /** Hard-kill semantics for crash tests: drop sockets, close the log. */
  async kill(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const session of this.sessions.onlineSessions()) {
      session.socket.terminate();
    }
    await new Promise<void>((resolve) => {
      if (this.wss) this.wss.close(() => resolve());
      else resolve();
    });
    await this.events.close();
  }

  // -------------------------------------------------------------------------
  // Connections and auth
  // -------------------------------------------------------------------------

  private onConnection(socket: WebSocket): void {
    socket.on("message", (raw) => {
      const text = raw.toString();
      if (text.length > this.config.maxMessageBytes) {
        this.sendTo(socket, makeMessage("ERROR", { code: "MESSAGE_TOO_LARGE", detail: "oversized message" }));
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text);
      } catch {
        this.sendTo(socket, makeMessage("ERROR", { code: "BAD_JSON", detail: "unparseable message" }));
        return;
      }
      void this.handleMessage(socket, msg).catch((e) => {
        this.sendTo(socket, makeMessage("ERROR", { code: "INTERNAL", detail: String(e) }));
      });
    });
    socket.on("close", () => {
      const session = this.sessions.remove(socket);
      if (session) {
        const seat = this.seats.get(session.playerId);
        if (seat) {
          seat.connected = false;
          this.broadcast(makeMessage("SEAT_STATUS", { playerId: session.playerId, lifecycle: "DISCONNECTED", connected: false }));
        }
      }
    });
  }

  private sendTo(socket: WebSocket, message: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(serializeBigints(message)));
  }

  private async handleMessage(socket: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? "");
    const payload = (msg.payload ?? {}) as Record<string, unknown>;

    if (type === "PING") {
      this.sendTo(socket, makeMessage("PONG", {}));
      return;
    }

    const session = this.sessions.get(socket);
    if (session && !this.limiter.allow(session, Date.now())) {
      this.sendTo(socket, makeMessage("ERROR", { code: "RATE_LIMITED", detail: "slow down" }));
      return;
    }

    switch (type) {
      case "HELLO": {
        const pubkey = String(payload.pubkey ?? "");
        if (!/^[0-9a-f]{66}$/.test(pubkey)) {
          this.sendTo(socket, makeMessage("AUTH_FAILED", { reason: "bad pubkey" }));
          return;
        }
        const challenge = createChallenge(Date.now(), () => toHex(crypto.getRandomValues(new Uint8Array(32))));
        this.sessions.createPending(socket, pubkey, challenge);
        this.sendTo(socket, makeMessage("AUTH_CHALLENGE", { challengeId: challenge.challengeId, challenge: challenge.challenge }));
        return;
      }
      case "AUTH_RESPONSE": {
        const pending = this.sessions.takePending(socket);
        if (!pending) {
          this.sendTo(socket, makeMessage("AUTH_FAILED", { reason: "no pending challenge" }));
          return;
        }
        const signature = String(payload.signature ?? "");
        const ok = verifyChallengeResponse(pending.challenge, pending.pubkey, signature, Date.now());
        if (!ok) {
          this.sendTo(socket, makeMessage("AUTH_FAILED", { reason: "signature invalid or challenge expired" }));
          return;
        }
        const session = this.sessions.register(socket, pending.pubkey);
        await this.events.append({
          tableId: this.config.tableId,
          handId: null,
          sequence: null,
          eventType: "PlayerAuthenticated",
          createdAt: new Date().toISOString(),
          payload: { playerId: pending.pubkey },
          fiberRef: null,
        });
        this.sendTo(socket, makeMessage("WELCOME", {
          sessionId: session.sessionId,
          tablePubkey: this.runtime.tablePublicKey,
          tableId: this.config.tableId,
          trustModel: "authoritative-but-auditable (not trustless)",
          // The player side provisions its own channel capacity toward THIS
          // peer (capacity.ts); the poker key alone is not routable.
          ...(this.gateway
            ? { fiberPeerPubkey: await this.gateway.nodePubkey().catch(() => undefined) }
            : {}),
          devMode: {
            autoPay: this.config.autoPay,
            fakeSettlement: this.adapter instanceof FakeSettlementAdapter,
          },
        }));
        this.sendSnapshot(socket);
        return;
      }
      case "JOIN_TABLE":
        await this.runExclusive(() => this.joinTable(socket, payload));
        return;
      case "ACTION":
        await this.runExclusive(() => this.onPlayerAction(socket, payload.envelope as ActionEnvelope));
        return;
      case "LEAVE_REQUEST":
        await this.runExclusive(() => this.requestLeave(socket));
        return;
      case "TOP_UP":
        await this.runExclusive(() => this.requestTopUp(socket, payload));
        return;
      case "SIT_IN":
      case "SIT_OUT":
        await this.runExclusive(() => this.sitInOut(socket, type === "SIT_IN"));
        return;
      case "SEED_COMMIT":
        await this.runExclusive(() => this.onSeedCommit(socket, payload));
        return;
      case "SEED_REVEAL":
        await this.runExclusive(() => this.onSeedReveal(socket, payload));
        return;
      case "ACK_STATE": {
        // Client state acknowledgement: durable dispute evidence. Each
        // (playerId, sequence, stateHash) ack is appended to the event log
        // so a third party can prove which states each player has seen and
        // implicitly accepted.
        const session = this.sessions.get(socket);
        if (!session) return;
        const seq = String(payload.sequence ?? "");
        const stateHash = String(payload.stateHash ?? "");
        if (!/^\d+$/.test(seq) || !/^[0-9a-f]{64}$/.test(stateHash)) {
          this.sendTo(socket, makeMessage("ERROR", { code: "BAD_ACK", detail: "sequence/stateHash malformed" }));
          return;
        }
        const previous = this.acks.get(session.playerId);
        if (previous && previous.stateHash === stateHash) return; // idempotent
        const ack = { sequence: seq, stateHash, at: new Date().toISOString() };
        this.acks.set(session.playerId, ack);
        await this.events.append({
          tableId: this.config.tableId,
          handId: null,
          sequence: seq,
          eventType: "StateAckRecorded",
          createdAt: ack.at,
          payload: { playerId: session.playerId, stateHash },
          stateHash,
          fiberRef: null,
        });
        return;
      }
      case "RESYNC":
        this.sendSnapshot(socket);
        return;
      case "DECK_AUDIT": {
        const handId = String(payload.handId ?? "");
        const reveal = this.reveals.get(handId);
        if (reveal) {
          this.sendTo(socket, makeMessage("DECK_REVEALED", reveal as Record<string, unknown>));
        } else {
          this.sendTo(socket, makeMessage("ERROR", { code: "NO_REVEAL", detail: `no reveal for ${handId}` }));
        }
        return;
      }
      default:
        this.sendTo(socket, makeMessage("ERROR", { code: "UNKNOWN_TYPE", detail: type }));
    }
  }

  private sendSnapshot(socket: WebSocket): void {
    const state: PublicTableState = publicView(this.runtime.state);
    this.sendTo(socket, makeMessage("TABLE_SNAPSHOT", {
      state,
      seats: this.seatStatuses(),
      chainTip: { sequence: this.runtime.tip.sequence.toString(), stateHash: this.runtime.tip.stateHash },
      acks: [...this.acks.entries()].map(([playerId, a]) => ({ playerId, ...a })),
      devMode: {
        autoPay: this.config.autoPay,
        fakeSettlement: this.adapter instanceof FakeSettlementAdapter,
      },
    }));
    // A player resyncing mid-hand must not lose their private view: replay
    // their hole cards and, if the acting seat is theirs, their turn (with
    // the ORIGINAL deadline — resync never extends the timer).
    const session = this.sessions.get(socket);
    if (!session || this.recovering) return;
    const full = this.runtime.state;
    if (full.handId) {
      const seat = full.seats.find((s) => s.playerId === session.playerId);
      if (seat && seat.holeCards.length > 0) {
        this.sendTo(socket, makeMessage("HOLE_CARDS", {
          handId: full.handId,
          cards: seat.holeCards,
        }));
      }
    }
    if (
      full.handId &&
      full.actingSeat !== undefined &&
      (full.phase === "PREFLOP" || full.phase === "FLOP" || full.phase === "TURN" || full.phase === "RIVER")
    ) {
      const acting = full.seats[full.actingSeat]!;
      if (acting.playerId === session.playerId) {
        const key = `${full.handId}:${full.sequence}`;
        const deadline =
          this.currentTurnDeadline?.key === key
            ? this.currentTurnDeadline.deadlineUnixMs
            : Date.now() + this.config.turnTimeoutMs;
        if (deadline > Date.now()) {
          this.sendTo(socket, makeMessage("YOUR_TURN", {
            payload: {
              handId: full.handId,
              deadlineUnixMs: deadline,
              legal: this.engine.legalActions(full, session.playerId),
              sequence: this.runtime.tip.sequence + 1n,
            },
          }));
        }
      }
    }
  }

  acksFor(playerId: string): { sequence: string; stateHash: string; at: string } | undefined {
    return this.acks.get(playerId);
  }

  // -------------------------------------------------------------------------
  // Join / leave / seat lifecycle
  // -------------------------------------------------------------------------

  private async joinTable(socket: WebSocket, payload: Record<string, unknown>): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session) {
      this.sendTo(socket, makeMessage("ERROR", { code: "UNAUTHENTICATED", detail: "authenticate first" }));
      return;
    }
    const playerId = session.playerId;
    if (this.seats.has(playerId)) {
      this.sendTo(socket, makeMessage("ERROR", { code: "ALREADY_SEATED", detail: "already seated" }));
      return;
    }
    const buyIn = BigInt(String(payload.buyInShannons ?? "0"));
    if (buyIn <= 0n) {
      this.sendTo(socket, makeMessage("ERROR", { code: "INVALID_BUY_IN", detail: "buyInShannons must be positive" }));
      return;
    }
    const requestedSeat = payload.seat !== undefined ? Number(payload.seat) : undefined;

    // docs/15: the player's fiber node key differs from their poker session
    // key. A declaring player supplies its fiber node pubkey; the table
    // routes channel ops and payouts to it. Trust note (V0): a false
    // declaration can only misdirect the DECLARER'S own payouts — there is
    // no path where it takes funds from other players. Static
    // FIBER_POKER_PEER_MAP entries take precedence over declarations.
    const declaredPeer = typeof payload.fiberPeerPubkey === "string" ? payload.fiberPeerPubkey : undefined;
    if (declaredPeer) {
      if (!/^(02|03)[0-9a-f]{64}$/.test(declaredPeer)) {
        this.sendTo(socket, makeMessage("ERROR", { code: "BAD_FIBER_PEER", detail: "fiberPeerPubkey must be 33-byte compressed hex" }));
        return;
      }
      if (!this.peerMap.has(playerId)) this.peerMap.set(playerId, declaredPeer);
    }

    // 1. Channel negotiation (private bidirectional channel per seat).
    this.channels.setLifecycle(playerId, "CONNECTED");
    await this.events.append({
      tableId: this.config.tableId,
      handId: null,
      sequence: null,
      eventType: "PlayerConnected",
      createdAt: new Date().toISOString(),
      payload: { playerId },
      fiberRef: null,
    });
    const channelId = await this.channels.ensureChannel(playerId);
    await this.events.append({
      tableId: this.config.tableId,
      handId: null,
      sequence: null,
      eventType: "ChannelReady",
      createdAt: new Date().toISOString(),
      payload: { playerId, channelId },
      fiberRef: channelId,
    });

    // 2. Seat selection (memory + authoritative engine state).
    const taken = new Set([...this.seats.values()].map((s) => s.seat));
    for (const s of this.runtime.state.seats) {
      if (s.playerId !== null) taken.add(s.seat);
    }
    let seat = -1;
    if (requestedSeat !== undefined && !taken.has(requestedSeat) && requestedSeat >= 0 && requestedSeat < this.tableConfig.maxSeats) {
      seat = requestedSeat;
    } else {
      for (let i = 0; i < this.tableConfig.maxSeats; i++) {
        if (!taken.has(i)) {
          seat = i;
          break;
        }
      }
    }
    if (seat < 0) {
      this.sendTo(socket, makeMessage("ERROR", { code: "TABLE_FULL", detail: "no open seats" }));
      return;
    }

    // 3. Liquidity check: table must be able to pay this stack back out.
    this.channels.setLifecycle(playerId, "LIQUIDITY_CHECK");
    await this.liquidity.refresh([{ playerId }]);
    let canPay = this.liquidity.canStartHand(new Map([[playerId, buyIn]]));
    if (!canPay.ok && this.gateway && this.config.autoCapacity) {
      // Auto-provision table-side payout capacity (P3 polish): the join
      // must not fail for a shortfall the table can fix with one funded
      // channel open (player-side capacity is the player's own job).
      const info = this.liquidity.usableOutboundFor(playerId);
      const shortfall = info ? buyIn - info.usableOutbound : 0n;
      if (info && shortfall > 0n) {
        const funding = shortfall * 2n > this.config.channelFunding ? shortfall * 2n : this.config.channelFunding;
        try {
          await this.gateway.openChannel(info.peer, funding);
          await this.liquidity.refresh([{ playerId }]);
          canPay = this.liquidity.canStartHand(new Map([[playerId, buyIn]]));
          await this.events.append({
            tableId: this.config.tableId,
            handId: null,
            sequence: null,
            eventType: "ChannelReady",
            createdAt: new Date().toISOString(),
            payload: { playerId, autoProvisioned: true, funding: funding.toString() },
            fiberRef: null,
          });
        } catch (e) {
          await this.events.append({
            tableId: this.config.tableId,
            handId: null,
            sequence: null,
            eventType: "PaymentFailed",
            createdAt: new Date().toISOString(),
            payload: { autoCapacity: true, playerId, error: String(e) },
            fiberRef: null,
          });
        }
      }
    }
    if (!canPay.ok) {
      this.sendTo(socket, makeMessage("ERROR", { code: "INSUFFICIENT_TABLE_LIQUIDITY", detail: canPay.reason }));
      return;
    }

    // 4. Buy-in payment BEFORE seating (payment-before-commit).
    const buyInObligationId = `buyin:${playerId.slice(0, 12)}:${Date.now()}-${++this.commitCount}`;
    const settled = await this.coordinator.fulfil(
      [
        {
          kind: "PAY_TABLE" as const,
          playerId,
          amount: buyIn,
          reason: "BET" as const,
          obligationId: buyInObligationId,
        },
      ],
      { handId: "", sequence: this.runtime.tip.sequence, actionHash: `buyin:${playerId.slice(0, 10)}` },
    );
    if (settled !== "SETTLED") {
      // Player protection: the payment may have settled late (refund it)
      // or be stuck Open (cancel it) — never strand the player's money.
      await this.resolveAbandonedPayment(playerId, buyIn, buyInObligationId);
      this.sendTo(socket, makeMessage("ERROR", { code: "BUY_IN_FAILED", detail: "settlement failed" }));
      return;
    }

    // 5. Seat the player via a committed engine action — immediately between
    // hands, otherwise queued until the live hand completes (docs/10 D009:
    // membership changes only between hands).
    const phaseNow = this.runtime.state.phase;
    if (phaseNow !== "WAITING" && phaseNow !== "HAND_COMPLETE") {
      this.joinQueue.push({ playerId, seat, buyIn, channelId });
      this.notify(playerId, { type: "SEAT_STATUS", payload: { lifecycle: "SEAT_QUEUED", seat } });
      return;
    }
    await this.seatPlayer(playerId, seat, buyIn, channelId);
    if (this.config.autoStartHands) {
      await this.maybeStartHand();
    }
  }

  private async seatPlayer(playerId: string, seat: number, buyIn: bigint, channelId: string): Promise<void> {
    const r = await this.runtime.commit({ type: "SIT_DOWN", playerId, fiberPubkey: playerId, seat, buyIn });
    if (!r.ok) {
      this.notify(playerId, { type: "ERROR", payload: { code: r.code, detail: r.detail } });
      return;
    }
    this.seats.set(playerId, { playerId, seat, sittingOut: false, connected: this.sessions.isOnline(playerId) });
    await this.events.append({
      tableId: this.config.tableId,
      handId: null,
      sequence: null,
      eventType: "PlayerSeated",
      createdAt: new Date().toISOString(),
      payload: { playerId, seat, buyIn: buyIn.toString() },
      fiberRef: channelId,
    });
    this.broadcast(makeMessage("PLAYER_JOINED", { playerId, seat }));
    this.broadcastState(r.result);
    this.maybeSnapshot(r.result.eventId);
  }

  /**
   * Player protection for a FAILED PLAYER_TO_TABLE settlement (P3 polish):
   * ask the node what actually happened via the persisted payment hash.
   * Paid (a late settle past our window) -> refund immediately over the
   * channel; still Open/Received -> cancel so it can never be paid later.
   */
  private async resolveAbandonedPayment(playerId: string, amount: bigint, obligationId: string): Promise<void> {
    if (!this.gateway) return;
    const entry: { paymentHash?: string } | undefined =
      this.adapter instanceof ImmediateFiberSettlement
        ? this.adapter.entry(obligationId)
        : this.adapter instanceof HoldInvoiceSettlement
          ? this.adapter.entryFor(obligationId)
          : undefined;
    const hash = entry?.paymentHash;
    if (!hash) return;
    let note = "";
    try {
      const status = await this.gateway.invoiceStatus(hash);
      if (status === "Paid") {
        const refund = await this.gateway.sendToPeer(this.resolvePeer(playerId), amount);
        note = `refunded-on-abandon:${refund.paymentHash.slice(0, 14)}…`;
        await this.events.append({
          tableId: this.config.tableId,
          handId: null,
          sequence: null,
          eventType: "PayoutSucceeded",
          createdAt: new Date().toISOString(),
          payload: { obligationId, refundOnAbandon: true, paymentHash: hash, note },
          fiberRef: null,
        });
        return;
      }
      if (status === "Open" || status === "Received") {
        await this.gateway.cancelInvoice?.(hash);
        note = `cancelled-on-abandon:was-${status}`;
      } else {
        note = `invoice:${status}`;
      }
    } catch (e) {
      note = `resolve-failed:${String(e)}`;
    }
    await this.events.append({
      tableId: this.config.tableId,
      handId: null,
      sequence: null,
      eventType: "PaymentFailed",
      createdAt: new Date().toISOString(),
      payload: { obligationId, abandoned: true, paymentHash: hash, note },
      fiberRef: null,
    });
  }

  private async requestLeave(socket: WebSocket): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session) return;
    const record = this.seats.get(session.playerId);
    if (!record) return;
    this.leaveQueue.add(session.playerId);
    await this.events.append({
      tableId: this.config.tableId,
      handId: null,
      sequence: null,
      eventType: "LeaveRequested",
      createdAt: new Date().toISOString(),
      payload: { playerId: session.playerId },
      fiberRef: null,
    });
    this.notify(session.playerId, { type: "SEAT_STATUS", payload: { lifecycle: "LEAVE_PENDING" } });
    if (this.runtime.state.phase === "WAITING" || this.runtime.state.phase === "HAND_COMPLETE") {
      await this.processLeaveQueue();
    }
  }

  /**
   * Buy-in top-up for a seated player (docs/10 D009: between hands only).
   * Payment-before-commit, exactly like the initial buy-in; mid-hand
   * requests are queued and applied by processMembershipQueues.
   */
  private async requestTopUp(socket: WebSocket, payload: Record<string, unknown>): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session) {
      this.sendTo(socket, makeMessage("ERROR", { code: "UNAUTHENTICATED", detail: "authenticate first" }));
      return;
    }
    if (!this.seats.has(session.playerId)) {
      this.sendTo(socket, makeMessage("ERROR", { code: "NOT_SEATED", detail: "join the table before topping up" }));
      return;
    }
    let amount: bigint;
    try {
      amount = BigInt(String(payload.amountShannons ?? ""));
    } catch {
      amount = 0n;
    }
    if (amount <= 0n) {
      this.sendTo(socket, makeMessage("ERROR", { code: "INVALID_AMOUNT", detail: "amountShannons must be positive" }));
      return;
    }
    const phase = this.runtime.state.phase;
    if (phase !== "WAITING" && phase !== "HAND_COMPLETE") {
      this.topupQueue.set(session.playerId, (this.topupQueue.get(session.playerId) ?? 0n) + amount);
      this.notify(session.playerId, { type: "SEAT_STATUS", payload: { lifecycle: "TOP_UP_QUEUED" } });
      return;
    }
    await this.processTopUp(session.playerId, amount);
  }

  private async processTopUp(playerId: string, amount: bigint): Promise<void> {
    const topUpObligationId = `topup:${playerId.slice(0, 12)}:${Date.now()}-${++this.commitCount}`;
    const settled = await this.coordinator.fulfil(
      [
        {
          kind: "PAY_TABLE" as const,
          playerId,
          amount,
          reason: "TOP_UP" as const,
          obligationId: topUpObligationId,
        },
      ],
      { handId: "", sequence: this.runtime.tip.sequence, actionHash: `topup:${playerId.slice(0, 10)}` },
    );
    if (settled !== "SETTLED") {
      await this.resolveAbandonedPayment(playerId, amount, topUpObligationId);
      this.notify(playerId, { type: "ERROR", payload: { code: "TOP_UP_FAILED", detail: "settlement failed" } });
      return;
    }
    const r = await this.runtime.commit({ type: "TOP_UP", playerId, amount });
    if (!r.ok) {
      this.notify(playerId, { type: "ERROR", payload: { code: r.code, detail: r.detail } });
      return;
    }
    this.notify(playerId, { type: "TOP_UP_APPLIED", payload: { amount: amount.toString() } });
    this.broadcastState(r.result);
    this.maybeSnapshot(r.result.eventId);
  }

  private async processTopUpQueue(): Promise<void> {
    for (const [playerId, amount] of [...this.topupQueue]) {
      this.topupQueue.delete(playerId);
      if (!this.seats.has(playerId)) continue; // left before the window opened
      await this.processTopUp(playerId, amount);
    }
  }

  private async sitInOut(socket: WebSocket, sitIn: boolean): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session) return;
    const phase = this.runtime.state.phase;
    if (phase !== "WAITING" && phase !== "HAND_COMPLETE") {
      this.sendTo(socket, makeMessage("ERROR", { code: "WRONG_PHASE", detail: "between hands only" }));
      return;
    }
    const r = await this.runtime.commit({ type: sitIn ? "SIT_IN" : "SIT_OUT", playerId: session.playerId });
    if (!r.ok) {
      this.sendTo(socket, makeMessage("ERROR", { code: r.code, detail: r.detail }));
      return;
    }
    const record = this.seats.get(session.playerId);
    if (record) record.sittingOut = sitIn;
    this.broadcastState(r.result);
  }

  /** Membership queue: queued joins apply first, then top-ups, then leave payouts. */
  private async processMembershipQueues(): Promise<void> {
    for (const pending of [...this.joinQueue]) {
      this.joinQueue = this.joinQueue.filter((j) => j.playerId !== pending.playerId);
      // The seat was chosen against a mid-hand snapshot that did not yet
      // include the other QUEUED joins — several pending joins can collide
      // on the same seat number. Re-check against the CURRENT state and
      // fall back to any open seat before committing.
      const taken = new Set(
        this.runtime.state.seats.filter((s) => s.playerId !== null).map((s) => s.seat),
      );
      let seat = pending.seat;
      if (taken.has(seat)) {
        seat = -1;
        for (let i = 0; i < this.runtime.state.seats.length; i++) {
          if (!taken.has(i)) {
            seat = i;
            break;
          }
        }
      }
      if (seat < 0) {
        this.notify(pending.playerId, { type: "ERROR", payload: { code: "TABLE_FULL", detail: "no open seat at seat time" } });
        continue;
      }
      await this.seatPlayer(pending.playerId, seat, pending.buyIn, pending.channelId);
    }
    await this.processTopUpQueue();
    await this.processLeaveQueue();
  }

  /** Leave flow: payout stack -> stand up -> cooperative channel shutdown. */
  private async processLeaveQueue(): Promise<void> {
    for (const playerId of [...this.leaveQueue]) {
      const record = this.seats.get(playerId);
      if (!record) {
        this.leaveQueue.delete(playerId);
        continue;
      }
      const seatState = this.runtime.state.seats.find((s) => s.playerId === playerId);
      const stack = seatState?.stack ?? 0n;
      if (stack > 0n) {
        const settled = await this.coordinator.fulfil(
          [
            {
              kind: "PAY_PLAYER" as const,
              playerId,
              amount: stack,
              reason: "PAYOUT" as const,
              obligationId: `leave:${playerId.slice(0, 12)}:${Date.now()}-${++this.commitCount}`,
            },
          ],
          { handId: "", sequence: this.runtime.tip.sequence, actionHash: `leave:${playerId.slice(0, 10)}` },
        );
        if (settled !== "SETTLED") {
          // Fail-stop: keep the seat; operator resolves channel state.
          this.liquidity.pause(`leave payout failed for ${playerId.slice(0, 8)}…`);
          continue;
        }
      }
      const r = await this.runtime.commit({ type: "STAND_UP", playerId });
      if (!r.ok) continue;
      this.seats.delete(playerId);
      this.leaveQueue.delete(playerId);
      await this.channels.shutdownChannel(playerId);
      this.broadcast(makeMessage("PLAYER_LEFT", { playerId, seat: record.seat }));
      this.broadcastState(r.result);
      this.maybeSnapshot(r.result.eventId);
    }
  }

  // -------------------------------------------------------------------------
  // Hand controller
  // -------------------------------------------------------------------------

  async maybeStartHand(): Promise<void> {
    if (this.recovering || this.startingHand) return;
    if (this.seedProtocol) return; // P10 seed phase already running
    const phase = this.runtime.state.phase;
    if (phase !== "WAITING" && phase !== "HAND_COMPLETE") return;

    const eligible = [...this.seats.values()].filter((s) => s.connected && !s.sittingOut);
    if (eligible.length < 2) return;

    this.startingHand = true;
    try {
      // Pre-hand payout-capacity gate (docs/04).
      await this.liquidity.refresh(eligible);
      const stacks = new Map<string, bigint>();
      for (const s of eligible) {
        const st = this.runtime.state.seats.find((x) => x.playerId === s.playerId);
        if (st && st.stack > 0n) stacks.set(s.playerId, st.stack);
      }
      if (stacks.size < 2) return;
      const gate = this.liquidity.canStartHand(stacks);
      if (!gate.ok) {
        this.liquidity.pause(gate.reason);
        return;
      }

      const handNo = this.runtime.state.handNo + 1;
      const handId = `${this.config.tableId}-h${handNo}-${Date.now().toString(36)}`;

      // P10 multiparty seed protocol: collect commitments and reveals from
      // every eligible player plus the table before deriving the deck.
      if (this.deck instanceof MultiPartySeedDeck) {
        this.deck.beginSeedProtocol(handId, eligible.map((s) => s.playerId));
        this.seedProtocol = { handId, stage: "commit" };
        await this.events.append({
          tableId: this.config.tableId,
          handId,
          sequence: null,
          eventType: "SeedProtocolStarted",
          createdAt: new Date().toISOString(),
          payload: { handId, participants: eligible.map((s) => s.playerId) },
          fiberRef: null,
        });
        const deadline = Date.now() + this.config.seedTimeoutMs;
        this.broadcast(makeMessage("SEED_COMMITMENT_REQUEST", { handId, deadlineUnixMs: deadline }));
        this.armSeedTimer(handId, "commit");
        return; // hand start continues via advanceSeedProtocol
      }

      const commitment = await this.deck.commitForHand(handId);
      const deck = this.deck.deckForHand(handId);
      await this.beginHandWithDeck(handId, deck, commitment.commitment, stacks.size);
    } finally {
      this.startingHand = false;
    }
  }

  /** Shared tail of hand setup: persist, commit START_HAND, broadcast. */
  private async beginHandWithDeck(handId: string, deck: number[], commitmentHex: string, playerCount: number): Promise<void> {
    {
      await this.events.append({
        tableId: this.config.tableId,
        handId,
        sequence: null,
        eventType: "HandStarted",
        createdAt: new Date().toISOString(),
        payload: { handId, players: playerCount },
        fiberRef: null,
      });
      await this.events.append({
        tableId: this.config.tableId,
        handId,
        sequence: null,
        eventType: "DeckCommitted",
        createdAt: new Date().toISOString(),
        payload: { handId, commitment: commitmentHex },
        fiberRef: null,
      });

      const r = await this.runtime.commit({ type: "START_HAND", handId, deck, deckCommitment: commitmentHex });
      if (!r.ok) {
        console.error(`[table] START_HAND failed: ${r.code} ${r.detail}`);
        return;
      }
      this.currentHandId = handId;
      this.broadcast(makeMessage("HAND_START", {
        handId,
        deckCommitment: commitmentHex,
        state: r.result.commit.payload.state,
      }));
      this.broadcastState(r.result);
      await this.afterCommit(r.result);
    }
  }

  // -------------------------------------------------------------------------
  // P10 multiparty seed protocol
  // -------------------------------------------------------------------------

  private armSeedTimer(handId: string, stage: "commit" | "reveal"): void {
    const timer = setTimeout(() => {
      void this.runExclusive(() => this.advanceSeedProtocol(handId, stage, true)).catch((e) => {
        console.error(`[table] seed protocol (${stage}) failed:`, e);
      });
    }, this.config.seedTimeoutMs);
    this.seedTimers.push(timer);
  }

  private clearSeedTimers(): void {
    for (const t of this.seedTimers) clearTimeout(t);
    this.seedTimers = [];
  }

  private async onSeedCommit(socket: WebSocket, payload: Record<string, unknown>): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session || !this.seedProtocol || this.seedProtocol.stage !== "commit") return;
    const handId = String(payload.handId ?? "");
    if (handId !== this.seedProtocol.handId) return;
    const deck = this.deck as MultiPartySeedDeck;
    try {
      deck.submitCommitment(handId, session.playerId, String(payload.commitment ?? ""));
    } catch {
      this.sendTo(socket, makeMessage("ERROR", { code: "BAD_SEED_COMMIT", detail: "malformed commitment" }));
      return;
    }
    if (deck.commitmentsComplete(handId)) {
      await this.advanceSeedProtocol(handId, "commit", false);
    }
  }

  private async onSeedReveal(socket: WebSocket, payload: Record<string, unknown>): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session || !this.seedProtocol || this.seedProtocol.stage !== "reveal") return;
    const handId = String(payload.handId ?? "");
    if (handId !== this.seedProtocol.handId) return;
    const deck = this.deck as MultiPartySeedDeck;
    deck.submitReveal(handId, session.playerId, String(payload.seed ?? ""));
    // Complete as soon as every committed participant has revealed.
    if (this.seedRevealsComplete(handId)) {
      await this.advanceSeedProtocol(handId, "reveal", false);
    }
  }

  private seedRevealsComplete(handId: string): boolean {
    const deck = this.deck as MultiPartySeedDeck;
    const hand = deck["pending"].get(handId);
    if (!hand) return false;
    for (const p of hand.commitments.keys()) {
      if (!hand.reveals.has(p)) return false;
    }
    return true;
  }

  /**
   * Drive the seed protocol forward. `deadline` distinguishes the timer
   * path (anti-abort policy applies) from the fast path (everyone done).
   */
  private async advanceSeedProtocol(handId: string, stage: "commit" | "reveal", deadline: boolean): Promise<void> {
    if (!this.seedProtocol || this.seedProtocol.handId !== handId || this.seedProtocol.stage !== stage) return;
    const deck = this.deck as MultiPartySeedDeck;

    if (stage === "commit") {
      if (deadline) deck.commitmentsFixed(handId);
      else if (deck.commitmentsComplete(handId)) deck.commitmentsFixed(handId);
      else return; // still waiting; timer will fire
      this.clearSeedTimers();
      this.seedProtocol.stage = "reveal";
      const revealDeadline = Date.now() + this.config.seedTimeoutMs;
      this.broadcast(makeMessage("SEED_REVEAL_REQUEST", { handId, deadlineUnixMs: revealDeadline }));
      this.armSeedTimer(handId, "reveal");
      return;
    }

    // Reveal stage finished (everyone revealed, or the deadline expired):
    // the anti-abort policy applies either way.
    this.clearSeedTimers();
    this.seedProtocol = null;
    const satOut = deck.nonRevealers(handId);
    for (const p of satOut) {
      const r = await this.runtime.commit({ type: "SIT_OUT", playerId: p });
      if (!r.ok) continue;
      const record = this.seats.get(p);
      if (record) record.sittingOut = true;
      this.seedSatOut.add(p);
    }
    if (satOut.length > 0) {
      await this.events.append({
        tableId: this.config.tableId,
        handId,
        sequence: null,
        eventType: "SeedProtocolCompleted",
        createdAt: new Date().toISOString(),
        payload: { handId, satOut },
        fiberRef: null,
      });
    }

    // Need at least two dealt-in players after exclusions.
    const stillEligible = [...this.seats.values()].filter((s) => s.connected && !s.sittingOut);
    const withStacks = stillEligible.filter((s) => {
      const st = this.runtime.state.seats.find((x) => x.playerId === s.playerId);
      return st && st.stack > 0n;
    });
    if (withStacks.length < 2) {
      // Everyone left was sat out (or stacks gone): restore and try later.
      for (const p of satOut) {
        const r = await this.runtime.commit({ type: "SIT_IN", playerId: p });
        if (r.ok) {
          const record = this.seats.get(p);
          if (record) record.sittingOut = false;
          this.seedSatOut.delete(p);
        }
      }
      return;
    }

    // Derive FIRST: for the multiparty deck, deriveDeck materializes the
    // deck (and the reveal) from the revealed seeds.
    const cards = (this.deck as MultiPartySeedDeck).deriveDeck(handId);
    const commitment = await this.deck.commitForHand(handId);
    await this.beginHandWithDeck(handId, cards, commitment.commitment, withStacks.length);
  }

  /** Restore seed-sat-out players between hands. */
  private async restoreSeedSatOut(): Promise<void> {
    for (const p of [...this.seedSatOut]) {
      const r = await this.runtime.commit({ type: "SIT_IN", playerId: p });
      if (!r.ok) continue;
      const record = this.seats.get(p);
      if (record) record.sittingOut = false;
      this.seedSatOut.delete(p);
      this.broadcastState(r.result);
    }
  }


  private dealHoleCards(): void {
    for (const seat of this.runtime.state.seats) {
      if (seat.playerId && seat.holeCards.length > 0) {
        this.notify(seat.playerId, {
          type: "HOLE_CARDS",
          handId: this.runtime.state.handId,
          payload: { handId: this.runtime.state.handId, cards: seat.holeCards },
        });
      }
    }
  }

  /**
   * Player action: verify signature + replay protection + rules, settle the
   * payment, then commit. A failed payment NEVER commits the action.
   */
  private async onPlayerAction(socket: WebSocket, env: ActionEnvelope): Promise<void> {
    const session = this.sessions.get(socket);
    if (!env || !session) {
      this.sendTo(socket, makeMessage("ERROR", { code: "BAD_ENVELOPE", detail: "missing envelope" }));
      return;
    }
    const aHash = toHex(actionHash(env));

    // 1. Signature.
    if (!verifyEnvelopeSignature(env)) {
      this.sendTo(socket, makeMessage("ACTION_REJECTED", { code: "BAD_SIGNATURE", detail: "envelope signature invalid", actionHash: aHash }));
      return;
    }
    if (env.actorPubkey !== session.playerId) {
      this.sendTo(socket, makeMessage("ACTION_REJECTED", { code: "WRONG_KEY", detail: "signed by another key", actionHash: aHash }));
      return;
    }
    // 2. Replay protection (sequence + previous state hash + nonce).
    const tipCheck = this.runtime.validateEnvelope(env);
    if (!tipCheck.ok) {
      this.sendTo(socket, makeMessage("ACTION_REJECTED", { code: tipCheck.code, detail: tipCheck.detail, actionHash: aHash }));
      return;
    }
    if (this.usedNonces.has(env.nonce)) {
      this.sendTo(socket, makeMessage("ACTION_REJECTED", { code: "DUPLICATE_NONCE", detail: "nonce already used", actionHash: aHash }));
      return;
    }
    const action = tipCheck.action;
    // 3. Poker rules (pure dry-run).
    const ruleError = this.runtime.validateAction(action);
    if (ruleError) {
      this.sendTo(socket, makeMessage("ACTION_REJECTED", { code: ruleError.code, detail: ruleError.message, actionHash: aHash }));
      return;
    }

    // 4. Payment-before-commit for value-changing actions.
    const paying = this.engine.reduce(this.runtime.state, action);
    if (!paying.ok) {
      this.sendTo(socket, makeMessage("ACTION_REJECTED", { code: paying.error.code, detail: paying.error.message, actionHash: aHash }));
      return;
    }
    const toPay = paying.transition.obligations.filter((o) => o.kind === "PAY_TABLE" && o.amount > 0n);
    if (toPay.length > 0) {
      const settled = await this.fulfilWithTimeoutPolicy(toPay, {
        handId: this.runtime.state.handId,
        sequence: this.runtime.tip.sequence + 1n,
        actionHash: aHash,
      }, env.actorPubkey);
      if (!settled) {
        this.sendTo(socket, makeMessage("ACTION_REJECTED", { code: "SETTLEMENT_FAILED", detail: "payment did not settle; action not committed", actionHash: aHash }));
        this.notify(env.actorPubkey, { type: "PAYMENT_STATUS", payload: { status: "FAILED", actionHash: aHash } });
        return; // no state change; the player may retry within their turn
      }
    }

    // 5. Commit exactly once.
    const r = await this.runtime.commit(action, env);
    if (!r.ok) {
      this.sendTo(socket, makeMessage("ACTION_REJECTED", { code: r.code, detail: r.detail, actionHash: aHash }));
      return;
    }
    this.usedNonces.add(env.nonce);
    this.sendTo(socket, makeMessage("ACTION_ACCEPTED", { actionHash: aHash, sequence: r.result.commit.sequence }));
    this.broadcastState(r.result);
    this.maybeSnapshot(r.result.eventId);
    await this.afterCommit(r.result);
  }

  /**
   * Fulfil obligations; if the paying player stalls past the turn deadline,
   * the timeout path cancels the payment and resolves the turn instead.
   */
  private async fulfilWithTimeoutPolicy(
    obligations: EconomicObligation[],
    ctx: { handId: string; sequence: bigint; actionHash: string },
    playerId: string,
  ): Promise<boolean> {
    const pending = { obligationIds: obligations.map((o) => o.obligationId) };
    this.pendingPayments.set(playerId, pending);
    const settlePromise = this.coordinator.fulfil(obligations, ctx).then((r) => {
      if (this.pendingPayments.get(playerId) === pending) this.pendingPayments.delete(playerId);
      return r;
    });
    for (;;) {
      const result = await Promise.race([
        settlePromise.then((r) => ({ done: true as const, r })),
        new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 50)),
      ]);
      if (result.done) return result.r === "SETTLED";
      if (this.pendingPayments.get(playerId) !== pending) return false; // timeout path cancelled us
    }
  }

  /** Post-commit flow: blinds, street timers, settlement payouts. */
  private async afterCommit(result: CommitEventResult): Promise<void> {
    const phase = result.state.phase;

    if (phase === "PREFLOP" || phase === "FLOP" || phase === "TURN" || phase === "RIVER") {
      if (result.summary.startsWith("post_bb")) {
        // Cards are dealt when the big blind posts (PREFLOP entry).
        this.broadcast(makeMessage("STREET_CHANGED", { street: phase, state: publicView(result.state) }));
        this.dealHoleCards();
      } else if (result.summary.includes("street_")) {
        this.broadcast(makeMessage("STREET_CHANGED", { street: phase, state: publicView(result.state) }));
      }
      await this.startTurnTimer();
      return;
    }
    if (phase === "POST_SMALL_BLIND" || phase === "POST_BIG_BLIND") {
      await this.processBlindObligation(result.obligations);
      return;
    }
    if (phase === "SETTLEMENT") {
      await this.settleHand(result);
      return;
    }
    if (phase === "HAND_COMPLETE" || phase === "WAITING") {
      await this.processMembershipQueues();
      await this.restoreSeedSatOut();
      if (this.config.autoStartHands) {
        await this.maybeStartHand();
      }
    }
  }

  /** System-action pipeline for blinds. */
  private async processBlindObligation(obligations: EconomicObligation[]): Promise<void> {
    if (obligations.length === 0) return;
    const o = obligations[0]!;
    const settled = await this.coordinator.fulfil([o], {
      handId: this.runtime.state.handId,
      sequence: this.runtime.tip.sequence + 1n,
      actionHash: `blind:${o.obligationId}`,
    });
    if (settled !== "SETTLED") {
      // Deterministic policy (docs/03): blind payment failed -> abort the
      // pre-live hand, refund what was paid, pause hands.
      await this.abortCurrentHand("blind payment failed");
      return;
    }
    const r = await this.runtime.commit({ type: "POST_BLIND", playerId: o.playerId });
    if (!r.ok) return;
    this.broadcastState(r.result);
    this.maybeSnapshot(r.result.eventId);
    await this.afterCommit(r.result);
  }

  private async abortCurrentHand(reason: string): Promise<void> {
    const phase = this.runtime.state.phase;
    if (phase !== "POST_SMALL_BLIND" && phase !== "POST_BIG_BLIND" && phase !== "HAND_SETUP") return;
    const abortingHandId = this.currentHandId ?? "";
    const r = await this.runtime.commit({ type: "ABORT_HAND", reason });
    if (!r.ok) return;
    if (this.coordinator.holdMode) {
      // Cancel every held invoice for this hand: funds return to the payers
      // by protocol. The engine's refund obligations are satisfied by the
      // cancellation — paying them as well would double-pay.
      const cancelled = await this.coordinator.cancelHand(abortingHandId);
      void cancelled;
    } else if (r.result.obligations.length > 0) {
      await this.coordinator.fulfil(r.result.obligations, {
        handId: "",
        sequence: this.runtime.tip.sequence,
        actionHash: `abort:${Date.now()}`,
      });
    }
    this.broadcastState(r.result);
    this.maybeSnapshot(r.result.eventId);
  }

  private async settleHand(result: CommitEventResult): Promise<void> {
    // Reveal showdown cards to everyone.
    const showdowns = result.state.seats
      .filter((s) => s.playerId && s.holeCards.length > 0 && !s.folded)
      .map((s) => ({ playerId: s.playerId!, cards: s.holeCards }));
    this.broadcast(makeMessage("HAND_RESULT", {
      handId: this.currentHandId ?? "",
      awards: result.state.awards,
      board: result.state.board,
      showdowns,
      pots: result.state.pots,
    }));

    // Hold-mode completion policy: settle every held invoice for this hand
    // FIRST — the pot's chips genuinely reach the table before payouts flow.
    const settlingHandId = this.currentHandId ?? "";
    if (this.coordinator.holdMode && this.coordinator.heldCountFor(settlingHandId) > 0) {
      const { settled, failed } = await this.coordinator.finalizeHand(settlingHandId);
      if (failed.length > 0) {
        // Fail-stop: held chips did not settle; never distribute a pot that
        // the table has not actually collected.
        this.liquidity.pause(`hold finalize failed for ${settlingHandId}: ${failed.join("; ")}`);
        return;
      }
      void settled;
    }

    // Payouts: the hand completes only when every payout is terminal.
    if (result.obligations.length > 0) {
      const settled = await this.coordinator.fulfil(result.obligations, {
        handId: this.currentHandId ?? "",
        sequence: this.runtime.tip.sequence + 1n,
        actionHash: `payout:${this.currentHandId ?? ""}`,
      });
      if (settled !== "SETTLED") {
        // Fail-stop in SETTLEMENT: pots are decided; payouts must complete.
        this.liquidity.pause(`payout failed during settlement of ${this.currentHandId}`);
        return;
      }
    }
    const r = await this.runtime.commit({ type: "DISTRIBUTE_POTS" });
    if (!r.ok) return;
    this.lastCompletedHandId = this.currentHandId ?? "";
    this.broadcastState(r.result);
    this.maybeSnapshot(r.result.eventId);

    // Deck reveal for audit.
    const handId = this.lastCompletedHandId;
    if (handId) {
      try {
        const reveal = await this.deck.revealForHand(handId);
        this.reveals.set(handId, reveal);
        this.broadcast(makeMessage("DECK_REVEALED", reveal as unknown as Record<string, unknown>));
      } catch {
        /* deck service without reveal support */
      }
    }
    await this.processMembershipQueues();
    await this.restoreSeedSatOut();
    if (this.config.autoStartHands) {
      await this.maybeStartHand();
    }
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private async startTurnTimer(): Promise<void> {
    const state = this.runtime.state;
    if (state.actingSeat === undefined) return;
    const seat = state.seats[state.actingSeat]!;
    if (!seat.playerId) return;
    const handId = state.handId;
    const sequence = state.sequence.toString();
    const deadline = Date.now() + this.config.turnTimeoutMs;
    await this.events.append({
      tableId: this.config.tableId,
      handId,
      sequence,
      eventType: "TurnTimerStarted",
      createdAt: new Date().toISOString(),
      payload: { handId, sequence, actingSeat: state.actingSeat, deadlineUnixMs: deadline },
      fiberRef: null,
    });
    this.armTurnTimer(handId, sequence, state.actingSeat, this.config.turnTimeoutMs);
    this.notify(seat.playerId, {
      type: "YOUR_TURN",
      payload: {
        handId,
        deadlineUnixMs: deadline,
        legal: this.engine.legalActions(state, seat.playerId),
        sequence: this.runtime.tip.sequence + 1n,
      },
    });
  }

  private armTurnTimer(handId: string, sequence: string, actingSeat: number, timeoutMs: number): void {
    const key = `${handId}:${sequence}`;
    const old = this.turnTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      void this.runExclusive(() => this.resolveTimeout(actingSeat));
    }, timeoutMs);
    this.turnTimers.set(key, timer);
    this.currentTurnDeadline = { key, deadlineUnixMs: Date.now() + timeoutMs };
  }

  /** Disconnect policy: automatic CHECK if legal, otherwise FOLD. */
  private async resolveTimeout(actingSeat: number): Promise<void> {
    const state = this.runtime.state;
    if (state.actingSeat !== actingSeat) return;
    if (state.phase !== "PREFLOP" && state.phase !== "FLOP" && state.phase !== "TURN" && state.phase !== "RIVER") return;
    const seat = state.seats[actingSeat]!;
    if (!seat.playerId) return;
    const playerId = seat.playerId;

    // Cancel any stalled payment for this player first.
    const pending = this.pendingPayments.get(playerId);
    if (pending) {
      for (const id of pending.obligationIds) {
        const inflight = this.coordinator.inflight.get(id);
        if (inflight) await this.adapter.cancel?.(inflight.ref, "turn timeout");
      }
      this.pendingPayments.delete(playerId);
    }

    await this.events.append({
      tableId: this.config.tableId,
      handId: state.handId,
      sequence: state.sequence.toString(),
      eventType: "TurnTimeoutResolved",
      createdAt: new Date().toISOString(),
      payload: { handId: state.handId, sequence: state.sequence.toString(), actingSeat },
      fiberRef: null,
    });

    const legal = this.engine.legalActions(state, playerId);
    const canCheck = (legal?.actions as readonly string[]).includes("CHECK") ?? false;
    const action: PokerAction = canCheck ? { type: "TIMEOUT_CHECK", playerId } : { type: "TIMEOUT_FOLD", playerId };
    const r = await this.runtime.commit(action);
    if (!r.ok) return;
    this.broadcastState(r.result);
    this.maybeSnapshot(r.result.eventId);
    await this.afterCommit(r.result);
  }

  // -------------------------------------------------------------------------
  // Broadcast helpers
  // -------------------------------------------------------------------------

  private broadcastState(result: CommitEventResult): void {
    const wire = JSON.stringify(serializeBigints(result.commit));
    for (const session of this.sessions.onlineSessions()) {
      session.socket.send(wire);
    }
  }

  private broadcast(message: { type: string; payload?: unknown }): void {
    const msg = makeMessage(message.type, serializeBigints(message.payload ?? {}));
    const wire = JSON.stringify(msg);
    for (const session of this.sessions.onlineSessions()) {
      session.socket.send(wire);
    }
  }

  private maybeSnapshot(eventId: string): void {
    this.lastEventId = eventId;
    this.commitCount += 1;
    if (this.commitCount % this.config.snapshotEvery === 0) {
      void this.snapshots.save({
        lastEventId: eventId,
        stateHash: this.runtime.tip.stateHash,
        state: JSON.parse(serializeState(this.runtime.state)),
        savedAt: new Date().toISOString(),
        protocolVersion: 1,
      });
    }
  }

  isRecovering(): boolean {
    return this.recovering;
  }

  /** Actual listening port (useful when configured with port 0). */
  get port(): number {
    const addr = this.wss?.address();
    return typeof addr === "object" && addr ? addr.port : this.config.port;
  }

  chainTip(): { sequence: bigint; stateHash: string } {
    return { ...this.runtime.tip };
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
