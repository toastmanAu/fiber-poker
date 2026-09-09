/**
 * Browser poker session: challenge-response auth, signed envelopes,
 * state-chain verification, reconnect/resync.
 *
 * The browser NEVER receives or holds Fiber node credentials. Payments are
 * surfaced as PAYMENT_REQUIRED events; in the dev (fake settlement) mode the
 * server auto-approves them, which the UI labels clearly.
 */

import {
  type ActionEnvelope,
  buildEnvelope,
  nextStateHash,
  publicView,
  respondToChallenge,
  type PublicTableState,
  generateKeyPair,
} from "@fiber-poker/protocol";

/** JSON turns `undefined` optional fields into null; canonical encoding
 *  distinguishes absent from null, so restore absent-ness before hashing. */
function normalizeView<T>(view: T): T {
  const optionalStrings: (keyof PublicTableState)[] = ["street", "deckCommitment", "abortReason"];
  const optionalNums: (keyof PublicTableState)[] = ["buttonSeat", "smallBlindSeat", "bigBlindSeat", "actingSeat"];
  const out = { ...(view as Record<string, unknown>) };
  for (const k of optionalStrings) if (out[k as string] === null) delete out[k as string];
  for (const k of optionalNums) if (out[k as string] === null) delete out[k as string];
  for (const seat of out.seats as Record<string, unknown>[]) {
    for (const k of ["playerId", "fiberPubkey", "holeCardsHash"]) {
      if (seat[k] === null) delete seat[k];
    }
  }
  return out as unknown as T;
}

export interface StatusFlags {
  wsConnected: boolean;
  authenticated: boolean;
  channelReady: boolean;
  seatReady: boolean;
  paymentPending: boolean;
  sittingOut: boolean;
  reconnecting: boolean;
}

export interface ChainObservation {
  sequence: bigint;
  stateHash: string;
  verifiedCount: number;
  broken: boolean;
}

type Handler = (msg: Record<string, unknown>) => void;

export class PokerSession {
  private ws: WebSocket | null = null;
  private url: string;
  private keys: { privateKey: string; publicKey: string };
  private handlers = new Map<string, Set<Handler>>();
  private expectedSeq = 0n;
  private lastStateHash = "";
  private challenge: { challengeId: string; challenge: string } | null = null;

  status: StatusFlags = {
    wsConnected: false,
    authenticated: false,
    channelReady: false,
    seatReady: false,
    paymentPending: false,
    sittingOut: false,
    reconnecting: false,
  };
  chain: ChainObservation = { sequence: 0n, stateHash: "", verifiedCount: 0, broken: false };
  tableState: PublicTableState | null = null;
  holeCards: string[] = [];
  yourTurn: Record<string, unknown> | null = null;
  tablePubkey = "";
  devMode = { autoPay: false, fakeSettlement: false };

  constructor(url: string) {
    this.url = url;
    this.keys = loadOrCreateKeys();
  }

  get pubkey(): string {
    return this.keys.publicKey;
  }

  on(type: string, handler: Handler): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }

  off(type: string, handler: Handler): void {
    this.handlers.get(type)?.delete(handler);
  }

  private emit(type: string, msg: Record<string, unknown>): void {
    this.handlers.get(type)?.forEach((h) => h(msg));
    this.handlers.get("*")?.forEach((h) => h(msg));
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () => reject(new Error("connection failed"));
      setTimeout(() => reject(new Error("connection timeout")), 8000);
    });
    this.ws.onmessage = (ev) => this.ingest(JSON.parse(ev.data as string));
    this.ws.onclose = () => {
      this.status.wsConnected = false;
      this.status.reconnecting = true;
      this.emit("status", {});
      setTimeout(() => void this.reconnect(), 1500);
    };
    this.status.wsConnected = true;
    this.send("HELLO", { pubkey: this.keys.publicKey });
  }

  async reconnect(): Promise<void> {
    try {
      this.handlers.get("*")?.clear();
      await this.connect();
      this.status.reconnecting = false;
      await this.authenticate();
      // Resync: send our last accepted chain position; server answers with a snapshot.
      this.send("RESYNC", { lastSequence: this.expectedSeq.toString(), lastStateHash: this.lastStateHash });
    } catch {
      setTimeout(() => void this.reconnect(), 2000);
    }
  }

  private ingest(raw: Record<string, unknown>): void {
    const type = String(raw.type);
    switch (type) {
      case "AUTH_CHALLENGE":
        this.challenge = raw.payload as { challengeId: string; challenge: string };
        this.emit("auth_challenge", raw);
        break;
      case "WELCOME": {
        this.status.authenticated = true;
        const p = raw.payload as { tablePubkey: string; devMode?: { autoPay: boolean; fakeSettlement: boolean } };
        this.tablePubkey = p.tablePubkey;
        if (p.devMode) this.devMode = p.devMode;
        break;
      }
      case "HOLE_CARDS":
        this.holeCards = (raw.payload as { cards: string[] }).cards;
        break;
      case "YOUR_TURN":
        this.yourTurn = raw.payload as Record<string, unknown>;
        break;
      case "STATE_COMMIT":
        this.observeCommit(raw as unknown as { payload: { stateHash: string; previousStateHash: string; state: PublicTableState; actionHash: string } });
        break;
      case "TABLE_SNAPSHOT": {
        const p = raw.payload as { state: PublicTableState; chainTip?: { sequence: string; stateHash: string } };
        this.tableState = normalizeView(p.state);
        if (p.chainTip) {
          this.expectedSeq = BigInt(p.chainTip.sequence);
          this.lastStateHash = p.chainTip.stateHash;
        }
        break;
      }
      case "PAYMENT_REQUIRED":
        this.status.paymentPending = true;
        if (this.devMode.autoPay) {
          setTimeout(() => {
            this.status.paymentPending = false;
            this.emit("status", {});
          }, 1200);
        }
        break;
      case "PAYMENT_STATUS":
        this.status.paymentPending = false;
        break;
      case "SEAT_STATUS":
        this.observeSeatStatus(String((raw.payload as { lifecycle: string }).lifecycle));
        break;
    }
    this.emit(type, raw);
    this.emit("status", {});
  }

  private observeSeatStatus(lifecycle: string): void {
    if (lifecycle === "CHANNEL_READY" || lifecycle === "LIQUIDITY_CHECK") this.status.channelReady = true;
    if (lifecycle === "SEAT_READY" || lifecycle === "PLAYING") {
      this.status.seatReady = true;
      this.status.channelReady = true;
    }
    if (lifecycle === "DISCONNECTED") {
      this.status.seatReady = false;
    }
  }

  /** Verify every commit links to the previous hash we accepted. */
  private observeCommit(commit: { payload: { stateHash: string; previousStateHash: string; state: PublicTableState; actionHash: string } }): void {
    const p = commit.payload;
    if (this.lastStateHash && p.previousStateHash !== this.lastStateHash) {
      this.chain.broken = true;
    }
    // Recompute the chain hash over the public state (full client audit).
    const view = normalizeView(p.state);
    const expected = nextStateHash(p.previousStateHash, p.actionHash, view);
    if (expected !== p.stateHash) {
      this.chain.broken = true;
    } else {
      this.chain.verifiedCount += 1;
      // Acknowledge verified states: durable dispute evidence on the server
      // (docs/05 ACK(tableId, handId, sequence, stateHash)).
      this.send("ACK_STATE", { sequence: String(p.state.sequence), stateHash: p.stateHash });
    }
    this.expectedSeq = BigInt(String(p.state.sequence));
    this.lastStateHash = p.stateHash;
    this.tableState = view;
    this.chain.sequence = this.expectedSeq;
    this.chain.stateHash = p.stateHash;
  }

  async authenticate(): Promise<void> {
    if (!this.challenge) {
      await new Promise<void>((resolve) => this.on("auth_challenge", () => resolve()));
    }
    if (!this.challenge) return;
    const signature = respondToChallenge(this.keys.privateKey, {
      ...this.challenge,
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    this.send("AUTH_RESPONSE", { pubkey: this.keys.publicKey, challengeId: this.challenge.challengeId, signature });
  }

  async join(buyInCkb: number, seat?: number): Promise<void> {
    this.send("JOIN_TABLE", {
      buyInShannons: BigInt(Math.round(buyInCkb * 100_000_000)).toString(),
      ...(seat !== undefined ? { seat } : {}),
    });
  }

  async act(action: { type: string; amount?: bigint }): Promise<void> {
    const env: ActionEnvelope = buildEnvelope({
      privateKey: this.keys.privateKey,
      actorPubkey: this.keys.publicKey,
      tableId: this.tableState?.tableId ?? "fiber-poker-table-1",
      handId: this.tableState?.handId ?? "",
      sequence: this.expectedSeq + 1n,
      previousStateHash: this.lastStateHash,
      action,
      nonce: randomNonce(),
    });
    this.send("ACTION", { envelope: env });
  }

  leave(): void {
    this.send("LEAVE_REQUEST", {});
  }

  requestDeckAudit(handId: string): void {
    this.send("DECK_AUDIT", { handId });
  }

  private send(type: string, payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, protocolVersion: 1, messageId: randomNonce(), payload }));
    }
  }

  /** Public view helper for audits. */
  static viewOf(state: PublicTableState): PublicTableState {
    return publicView(state as never);
  }
}

function randomNonce(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function loadOrCreateKeys(): { privateKey: string; publicKey: string } {
  const raw = localStorage.getItem("fiber-poker-key");
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      /* regenerate */
    }
  }
  const keys = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  localStorage.setItem("fiber-poker-key", JSON.stringify(keys));
  return keys;
}
