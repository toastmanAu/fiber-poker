/**
 * TestClient: a scripted poker player for integration tests and demos.
 * Speaks the real WS protocol: challenge-response auth, envelopes with
 * sequence/previous-hash tracking, resync support. Uses the same crypto the
 * browser client uses (@noble over WebCrypto-free APIs).
 */

import WebSocket from "ws";
import {
  type ActionEnvelope,
  actionHash,
  buildEnvelope,
  respondToChallenge,
} from "@fiber-poker/protocol";
import { seedCommitment, SEED_BYTES } from "@fiber-poker/deck";

export interface PublicSeatView {
  seat: number;
  playerId: string | null;
  stack: string;
  holeCardsHash?: string;
  folded: boolean;
  allIn: boolean;
  [k: string]: unknown;
}

export type WaitFilter = (msg: Record<string, unknown>) => boolean;

export class TestClient {
  readonly privKey: string;
  readonly pubkey: string;
  private ws: WebSocket | null = null;
  private inbox: Record<string, unknown>[] = [];
  private waiters: { filter: WaitFilter; resolve: (m: Record<string, unknown>) => void; timer: NodeJS.Timeout }[] = [];
  private sequence = 0n;
  private stateHash = "";
  welcome: Record<string, unknown> | null = null;
  holeCards: string[] = [];
  /** P10: per-hand secret seeds (committed then revealed). */
  seedSeeds = new Map<string, Uint8Array>();
  yourTurn: Record<string, unknown> | null = null;
  commits: Record<string, unknown>[] = [];

  constructor(keyPair: { privateKey: string; publicKey: string }, readonly label = "client") {
    this.privKey = keyPair.privateKey;
    this.pubkey = keyPair.publicKey;
  }

  get id(): string {
    return this.pubkey;
  }

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws!.on("open", resolve);
      this.ws!.on("error", reject);
    });
    this.ws!.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      this.ingest(msg);
    });
    this.send("HELLO", { pubkey: this.pubkey });
    const challenge = await this.waitFor("AUTH_CHALLENGE");
    const signature = respondToChallenge(
      this.privKey,
      challenge.payload as unknown as Parameters<typeof respondToChallenge>[1],
    );
    this.send("AUTH_RESPONSE", { pubkey: this.pubkey, challengeId: (challenge.payload as { challengeId: string }).challengeId, signature });
    this.welcome = await this.waitFor("WELCOME");
  }

  private ingest(msg: Record<string, unknown>): void {
    if (msg.type === "STATE_COMMIT") {
      this.commits.push(msg);
      const p = msg.payload as { stateHash: string };
      this.sequence = BigInt(msg.sequence as string);
      this.stateHash = p.stateHash;
    }
    if (msg.type === "HOLE_CARDS") {
      this.holeCards = (msg.payload as { cards: string[] }).cards;
    }
    if (msg.type === "YOUR_TURN") {
      this.yourTurn = msg.payload as Record<string, unknown>;
    }
    if (msg.type === "SEED_COMMITMENT_REQUEST") {
      // P10: generate a per-hand secret seed, commit it.
      const handId = (msg.payload as { handId: string }).handId;
      const seed = new Uint8Array(SEED_BYTES);
      crypto.getRandomValues(seed);
      this.seedSeeds.set(handId, seed);
      this.send("SEED_COMMIT", { handId, commitment: seedCommitment(handId, this.pubkey, seed) });
    }
    if (msg.type === "SEED_REVEAL_REQUEST") {
      const handId = (msg.payload as { handId: string }).handId;
      const seed = this.seedSeeds.get(handId);
      if (seed) {
        this.send("SEED_REVEAL", { handId, seed: toHexLocal(seed) });
      }
    }
    if (msg.type === "TABLE_SNAPSHOT") {
      const tip = (msg.payload as { chainTip?: { sequence: string; stateHash: string } }).chainTip;
      if (tip) {
        this.sequence = BigInt(tip.sequence);
        this.stateHash = tip.stateHash;
      }
    }
    // Dispatch to waiters first (FIFO), else park in the inbox.
    const idx = this.waiters.findIndex((w) => w.filter(msg));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    this.inbox.push(msg);
  }

  async waitFor(type: string, timeoutMs = 15_000, filter?: WaitFilter): Promise<Record<string, unknown>> {
    const parked = this.inbox.findIndex(
      (m) => m.type === type && (!filter || filter(m)),
    );
    if (parked >= 0) return this.inbox.splice(parked, 1)[0]!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`[${this.label}] timeout waiting for ${type}`));
      }, timeoutMs);
      this.waiters.push({
        filter: (m) => m.type === type && (!filter || filter(m)),
        resolve,
        timer,
      });
    });
  }

  /** Send a raw message (security tests use this). */
  sendRaw(type: string, payload: unknown): void {
    this.send(type, payload);
  }

  private send(type: string, payload: unknown): void {
    this.ws?.send(JSON.stringify({
      type,
      protocolVersion: 1,
      messageId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      payload,
    }));
  }

  async joinTable(buyInShannons: bigint, seat?: number): Promise<void> {
    this.send("JOIN_TABLE", { buyInShannons: buyInShannons.toString(), seat });
    await this.waitFor("PLAYER_JOINED", 20_000, (m) => (m.payload as { playerId?: string }).playerId === this.pubkey);
  }

  /** Send a signed poker action without waiting for acceptance; returns its action hash. */
  actRaw(action: { type: string; amount?: bigint }, opts?: { sequence?: bigint; stateHash?: string; nonce?: string }): string {
    const env: ActionEnvelope = buildEnvelope({
      privateKey: this.privKey,
      actorPubkey: this.pubkey,
      tableId: "fiber-poker-table-1",
      handId: "",
      sequence: (opts?.sequence ?? this.sequence) + 1n,
      previousStateHash: opts?.stateHash ?? this.stateHash,
      action,
      nonce: opts?.nonce ?? `n-${Math.random().toString(16).slice(2)}`,
    });
    this.send("ACTION", { envelope: env });
    let hex = "";
    for (const b of actionHash(env)) hex += b.toString(16).padStart(2, "0");
    return hex;
  }

  /** Send a signed poker action built on the client's current chain view. */
  async act(action: { type: string; amount?: bigint }, opts?: { sequence?: bigint; stateHash?: string; nonce?: string }): Promise<Record<string, unknown>> {
    const env: ActionEnvelope = buildEnvelope({
      privateKey: this.privKey,
      actorPubkey: this.pubkey,
      tableId: "fiber-poker-table-1",
      handId: (this.yourTurn as { handId?: string } | null)?.handId ?? "",
      sequence: (opts?.sequence ?? this.sequence) + 1n,
      previousStateHash: opts?.stateHash ?? this.stateHash,
      action,
      nonce: opts?.nonce ?? `n-${Math.random().toString(16).slice(2)}`,
    });
    void actionHash;
    this.send("ACTION", { envelope: env });
    return this.waitFor("ACTION_ACCEPTED", 15_000, (m) =>
      (m.payload as { actionHash?: string }).actionHash !== undefined);
  }

  async waitMyTurn(timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const m = await this.waitFor("YOUR_TURN", timeoutMs, (m) => Boolean(m.payload));
    this.yourTurn = m.payload as Record<string, unknown>;
    return m;
  }

  async leave(): Promise<void> {
    this.send("LEAVE_REQUEST", {});
    await this.waitFor("PLAYER_LEFT", 20_000, (m) => (m.payload as { playerId?: string }).playerId === this.pubkey);
  }

  async resync(): Promise<void> {
    this.send("RESYNC", { lastSequence: this.sequence.toString(), lastStateHash: this.stateHash });
    await this.waitFor("TABLE_SNAPSHOT");
  }

  async waitForRejected(actionHashHex: string, timeoutMs = 5000): Promise<string> {
    const m = await this.waitFor("ACTION_REJECTED", timeoutMs, (msg) =>
      (msg.payload as { actionHash?: string }).actionHash === actionHashHex);
    return (m.payload as { code: string }).code;
  }

  seatsFromLastCommit(): PublicSeatView[] {
    const last = this.commits.at(-1);
    if (!last) return [];
    return ((last.payload as { state: { seats: PublicSeatView[] } }).state).seats;
  }

  close(): void {
    this.ws?.close();
  }
}

function toHexLocal(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
