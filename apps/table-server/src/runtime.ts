/**
 * TableRuntime: the authoritative game state machine wrapper.
 *
 * Owns the full (private) TableState, the hash chain tip, and the event
 * store. Every committed engine action passes through `commit()`, which:
 *   1. applies the pure engine reducer,
 *   2. computes actionHash / nextStateHash over the canonical public view,
 *   3. signs the commit with the table key,
 *   4. persists an ActionCommitted event BEFORE the commit is broadcast.
 *
 * The engine itself stays pure: this class only sequences, hashes, signs,
 * and persists.
 */

import {
  FiberPokerEngine,
  PokerError,
  type EconomicObligation,
  type PokerAction,
  type TableState,
} from "@fiber-poker/poker-engine";
import {
  type ActionEnvelope,
  DOMAIN_TABLE_COMMIT,
  type PublicTableState,
  actionHash as canonicalActionHash,
  ckbHash,
  nextStateHash,
  publicView,
  signHash,
  verifyHash,
} from "@fiber-poker/protocol";
import type { EventStore } from "@fiber-poker/persistence";
import { parseAction, serializeAction } from "./serde.ts";

export interface ChainTip {
  sequence: bigint;
  stateHash: string;
}

export interface CommitResult {
  commit: StateCommitMessage;
  state: TableState;
  obligations: EconomicObligation[];
  summary: string;
  actionHash: string;
  stateHash: string;
  eventId: string;
}

export interface StateCommitMessage {
  type: "STATE_COMMIT";
  protocolVersion: number;
  messageId: string;
  tableId: string;
  handId: string;
  sequence: string;
  payload: {
    actionHash: string;
    previousStateHash: string;
    stateHash: string;
    summary: string;
    signature: string;
    state: PublicTableState;
    actionType: string;
  };
}

export class TableRuntime {
  state: TableState;
  tip: ChainTip;
  private readonly engine = new FiberPokerEngine();

  constructor(
    private readonly events: EventStore,
    private readonly tablePrivateKey: string,
    readonly tablePublicKey: string,
    state: TableState,
    tip: ChainTip,
  ) {
    this.state = state;
    this.tip = tip;
  }

  /**
   * Validate a player envelope against the current tip without applying it.
   * Returns the engine action on success or an error code + detail.
   */
  validateEnvelope(env: ActionEnvelope): { ok: true; action: PokerAction } | { ok: false; code: string; detail: string } {
    let seq: bigint;
    try {
      seq = BigInt(env.sequence);
    } catch {
      return { ok: false, code: "BAD_SEQUENCE", detail: "sequence not a number" };
    }
    const expected = this.tip.sequence + 1n;
    if (seq !== expected) {
      return {
        ok: false,
        code: seq <= this.tip.sequence ? "STALE_SEQUENCE" : "SEQUENCE_GAP",
        detail: `expected ${expected}`,
      };
    }
    if (env.previousStateHash !== this.tip.stateHash) {
      return { ok: false, code: "WRONG_PREVIOUS_STATE_HASH", detail: "chain tip moved" };
    }
    try {
      return { ok: true, action: envelopeToEngineActionSafe(env) };
    } catch (e) {
      return { ok: false, code: "BAD_ACTION", detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Commit an action. `envelope` is provided for player actions (its hash is
   * the transcript anchor); system actions are signed here by the table.
   */
  async commit(
    action: PokerAction,
    envelope?: ActionEnvelope,
  ): Promise<{ ok: true; result: CommitResult } | { ok: false; code: string; detail: string }> {
    // 1. Reduce (pure, on a clone).
    const r = this.engine.reduce(this.state, action);
    if (!r.ok) {
      return { ok: false, code: r.error.code, detail: r.error.message };
    }
    const nextState = r.transition.nextState;

    // 2. Transcript hashes over the canonical public view.
    const env = envelope ?? this.systemEnvelope(action, nextState.sequence);
    const aHash = toHex(canonicalActionHash(env));
    const prevHash = this.tip.stateHash;
    const stateHash = nextStateHash(prevHash, aHash, publicView(nextState));

    // 3. Table signature over the committed chain step.
    const signature = this.signCommit(prevHash, aHash, stateHash);

    // 4. Persist BEFORE the commit becomes visible.
    const persisted = await this.events.append({
      tableId: this.state.tableId,
      handId: nextState.handId || null,
      sequence: nextState.sequence.toString(),
      eventType: "ActionCommitted",
      createdAt: new Date().toISOString(),
      payload: {
        actionType: action.type,
        summary: r.transition.summary,
        action: serializeAction(action),
        envelopeSignature: env.signature,
        actorPubkey: env.actorPubkey,
        signature,
        actionHash: aHash,
      },
      stateHash,
      fiberRef: null,
    });

    // 5. Advance tip.
    this.state = nextState;
    this.tip = { sequence: nextState.sequence, stateHash };

    const commit: StateCommitMessage = {
      type: "STATE_COMMIT",
      protocolVersion: 1,
      messageId: `${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`,
      tableId: this.state.tableId,
      handId: this.state.handId,
      sequence: this.state.sequence.toString(),
      payload: {
        actionHash: aHash,
        previousStateHash: prevHash,
        stateHash,
        summary: r.transition.summary,
        signature,
        state: publicView(this.state),
        actionType: action.type,
      },
    };
    return {
      ok: true,
      result: {
        commit,
        state: this.state,
        obligations: r.transition.obligations,
        summary: r.transition.summary,
        actionHash: aHash,
        stateHash,
        eventId: persisted.eventId,
      },
    };
  }

  /** Dry-run an action for rule validation without touching state. */
  validateAction(action: PokerAction): PokerError | undefined {
    return this.engine.validate(this.state, action);
  }

  systemEnvelope(action: PokerAction, sequence: bigint): ActionEnvelope {
    const env: ActionEnvelope = {
      protocolVersion: 1,
      tableId: this.state.tableId,
      handId: this.state.handId,
      sequence: sequence.toString(),
      previousStateHash: this.tip.stateHash,
      actorPubkey: this.tablePublicKey,
      actionType: action.type,
      amountShannons: "amount" in action && action.amount !== undefined ? action.amount.toString() : "0",
      nonce: `sys-${sequence}`,
      signature: "",
    };
    env.signature = signHash(this.tablePrivateKey, canonicalActionHash(env));
    return env;
  }

  signCommit(prevHash: string, actionHashHex: string, stateHash: string): string {
    return signHash(this.tablePrivateKey, commitMessage(prevHash, actionHashHex, stateHash));
  }

  /** Verify a commit signature (used by recovery and tests). */
  verifyCommit(prevHash: string, actionHashHex: string, stateHash: string, signature: string): boolean {
    return verifyHash(this.tablePublicKey, commitMessage(prevHash, actionHashHex, stateHash), signature);
  }

  /**
   * Replay an ActionCommitted event into the state (recovery path). Throws
   * if the recomputed hash chain does not match the recorded stateHash.
   */
  replayEvent(payload: { action: unknown; actionHash: string }, stateHash: string): void {
    const action = parseAction(payload.action);
    const r = this.engine.reduce(this.state, action);
    if (!r.ok) throw new Error(`replay: action invalid: ${r.error.code}`);
    const nextState = r.transition.nextState;
    const aHash = payload.actionHash;
    const recomputed = nextStateHash(this.tip.stateHash, aHash, publicView(nextState));
    if (recomputed !== stateHash) {
      throw new Error(`replay: state hash mismatch (chain broken) at sequence ${nextState.sequence}`);
    }
    this.state = nextState;
    this.tip = { sequence: nextState.sequence, stateHash };
  }
}

function commitMessage(prevHash: string, actionHashHex: string, stateHash: string): Uint8Array {
  return ckbHash(
    new TextEncoder().encode(DOMAIN_TABLE_COMMIT),
    hexToBytes(prevHash),
    hexToBytes(actionHashHex),
    hexToBytes(stateHash),
  );
}

function envelopeToEngineActionSafe(env: ActionEnvelope): PokerAction {
  const playerId = env.actorPubkey;
  const amount = BigInt(env.amountShannons || "0");
  switch (env.actionType) {
    case "CHECK":
      return { type: "CHECK", playerId };
    case "CALL":
      return { type: "CALL", playerId };
    case "BET":
      return { type: "BET", playerId, amount };
    case "RAISE":
      return { type: "RAISE", playerId, amount };
    case "FOLD":
      return { type: "FOLD", playerId };
    case "ALL_IN":
      return { type: "ALL_IN", playerId };
    default:
      throw new Error(`clients may not submit ${env.actionType}`);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
