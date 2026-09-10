/**
 * Player Agent — docs/15's PlayerFiberBackend made real.
 *
 * A small process that holds a player's Fiber credentials and joins the
 * poker table on their behalf:
 *   - WS session authenticated with the player's poker session key
 *     (generated and persisted locally — the browser can hold the same
 *     key for a UI; the agent drives the headless flow)
 *   - DECLARES its Fiber node pubkey on JOIN_TABLE so the table routes
 *     channel ops and payouts to the player's own node
 *     (docs/15: session key ≠ fiber node key)
 *   - auto-pays every PAYMENT_REQUIRED invoice via its FNN node
 *   - plays a simple policy (check/call/fold) and leaves cleanly
 *
 * Trust note (documented, V0): the declared fiber peer is trusted for
 * ROUTING. A false declaration can only misdirect the declarer's own
 * payouts — there is no path where it takes funds from other players.
 */

import { WebSocket } from "ws";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  type ActionEnvelope,
  buildEnvelope,
  generateKeyPair,
  respondToChallenge,
} from "@fiber-poker/protocol";
import { RealFiberGateway } from "@fiber-poker/fiber-adapter";

export interface AgentConfig {
  tableUrl: string;
  fnnUrl: string;
  fnnToken: string;
  currency: "Fibb" | "Fibt" | "Fibd";
  sessionKeyPath: string;
  buyInShannons: bigint;
  label: string;
  /** Fold preflop, then check/call down — minimum-viable headless policy. */
  policy: "tight" | "call-station";
}

interface Pending<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  filter: (msg: Record<string, unknown>) => boolean;
}

export class PlayerAgent {
  readonly pubkey: string;
  private readonly privKey: string;
  private ws: WebSocket | null = null;
  private inbox: Record<string, unknown>[] = [];
  private waiters: Pending<Record<string, unknown>>[] = [];
  private sequence = 0n;
  private stateHash = "";
  private tableId = "fiber-poker-table-1";
  private handId = "";
  private readonly gateway: RealFiberGateway;

  constructor(private readonly cfg: AgentConfig) {
    const keys = this.loadKeys();
    this.privKey = keys.privateKey;
    this.pubkey = keys.publicKey;
    this.gateway = new RealFiberGateway({
      url: cfg.fnnUrl,
      authToken: cfg.fnnToken,
      currency: cfg.currency,
    });
  }

  private loadKeys(): { privateKey: string; publicKey: string } {
    if (existsSync(this.cfg.sessionKeyPath)) {
      return JSON.parse(readFileSync(this.cfg.sessionKeyPath, "utf8"));
    }
    const keys = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
    mkdirSync(dirname(this.cfg.sessionKeyPath) ?? ".", { recursive: true });
    writeFileSync(this.cfg.sessionKeyPath, JSON.stringify(keys), { mode: 0o600 });
    return keys;
  }

  /** Connect, authenticate, declare the fiber peer, and take the seat. */
  async join(): Promise<void> {
    await this.connect();
    this.send("JOIN_TABLE", {
      buyInShannons: this.cfg.buyInShannons.toString(),
      fiberPeerPubkey: await this.gateway.nodePubkey(),
    });
    await this.waitFor("PLAYER_JOINED", 60_000, (m) => (m.payload as { playerId?: string }).playerId === this.pubkey).catch((err) => {
      // Surface the table's rejection reason instead of a bare timeout.
      const errEv = [...this.inbox].reverse().find((m) => m.type === "ERROR");
      throw new Error(`join failed: ${errEv ? JSON.stringify(errEv.payload) : String(err)}`);
    });
    this.log("seated");
  }

  /** Convenience: join + play until turns stop. */
  async run(): Promise<void> {
    await this.join();
    await this.playLoop();
  }

  /**
   * Act on our turns until they stop (hand over / left / disconnected).
   * Safe to start before the hand begins — turns simply haven't arrived.
   */
  async playLoop(maxTurns = 40): Promise<void> {
    for (let n = 0; n < maxTurns; n++) {
      const turn = await this.waitFor("YOUR_TURN", 45_000).catch(() => null);
      if (!turn) return;
      const p = turn.payload as {
        handId: string;
        legal: { actions: string[]; callAmount: string };
      };
      this.handId = p.handId;
      const legal = p.legal?.actions ?? [];
      const act =
        this.cfg.policy === "call-station"
          ? legal.includes("CHECK")
            ? { type: "CHECK" }
            : legal.includes("CALL")
              ? { type: "CALL" }
              : { type: "FOLD" }
          : legal.includes("FOLD") && !legal.includes("CHECK")
            ? { type: "FOLD" }
            : legal.includes("CHECK")
              ? { type: "CHECK" }
              : legal.includes("CALL")
                ? { type: "CALL" }
                : { type: "FOLD" };
      await this.act(act);
    }
  }

  async leave(): Promise<void> {
    this.send("LEAVE_REQUEST", {});
    await this.waitFor("PLAYER_LEFT", 60_000, (m) => (m.payload as { playerId?: string }).playerId === this.pubkey).catch(() => undefined);
  }

  private async connect(): Promise<void> {
    this.ws = new WebSocket(this.cfg.tableUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws!.on("open", resolve);
      this.ws!.on("error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 10_000);
    });
    this.ws.on("message", (raw) => this.ingest(JSON.parse(raw.toString())));
    this.send("HELLO", { pubkey: this.pubkey });
    const ch = await this.waitFor("AUTH_CHALLENGE", 15_000);
    const challenge = ch.payload as unknown as Parameters<typeof respondToChallenge>[1];
    const signature = respondToChallenge(this.privKey, {
      ...challenge,
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    this.send("AUTH_RESPONSE", { pubkey: this.pubkey, challengeId: challenge.challengeId, signature });
    await this.waitFor("WELCOME", 15_000);
    this.log("authenticated");
  }

  private ingest(msg: Record<string, unknown>): void {
    if (msg.type === "STATE_COMMIT") {
      this.sequence = BigInt(msg.sequence as string);
      this.stateHash = (msg.payload as { stateHash: string }).stateHash;
    }
    if (msg.type === "TABLE_SNAPSHOT") {
      const tip = (msg.payload as { chainTip?: { sequence: string; stateHash: string } }).chainTip;
      if (tip) {
        this.sequence = BigInt(tip.sequence);
        this.stateHash = tip.stateHash;
      }
    }
    if (msg.type === "PAYMENT_REQUIRED") {
      const p = msg.payload as { invoiceAddress?: string; direction: string };
      if (p.direction === "PLAYER_TO_TABLE" && p.invoiceAddress) {
        this.payInvoice(p.invoiceAddress);
      }
    }
    const idx = this.waiters.findIndex((w) => w.filter(msg));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    this.inbox.push(msg);
  }

  private async payInvoice(invoiceAddress: string): Promise<void> {
    this.log(`paying invoice ${invoiceAddress.slice(0, 28)}…`);
    try {
      const r = await this.gateway.payInvoice(invoiceAddress);
      this.log(`paid ${r.paymentHash.slice(0, 14)}…`);
    } catch (e) {
      this.log(`PAY FAILED: ${String(e)}`);
    }
  }

  waitFor(type: string, timeoutMs: number, filter?: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const parked = this.inbox.findIndex((m) => m.type === type && (!filter || filter(m)));
    if (parked >= 0) return Promise.resolve(this.inbox.splice(parked, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`[${this.cfg.label}] timeout waiting for ${type}`));
      }, timeoutMs);
      this.waiters.push({ filter: (m) => m.type === type && (!filter || filter(m)), resolve, reject, timer });
    });
  }

  private async act(action: { type: string }): Promise<void> {
    const env: ActionEnvelope = buildEnvelope({
      privateKey: this.privKey,
      actorPubkey: this.pubkey,
      tableId: this.tableId,
      handId: this.handId,
      sequence: this.sequence + 1n,
      previousStateHash: this.stateHash,
      action,
      nonce: `n-${Math.random().toString(16).slice(2)}`,
    });
    this.send("ACTION", { envelope: env });
  }

  private send(type: string, payload: unknown): void {
    this.ws?.send(JSON.stringify({
      type,
      protocolVersion: 1,
      messageId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      payload,
    }));
  }

  private log(msg: string): void {
    console.log(`[${this.cfg.label}] ${msg}`);
  }
}
