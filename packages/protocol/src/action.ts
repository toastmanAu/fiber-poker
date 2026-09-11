/**
 * Mutating action envelope: canonical encoding, hashing, signing.
 *
 * Wire shape matches schemas/action-envelope.schema.json from the handoff;
 * the canonical BINARY encoding below is what actually gets hashed/signed.
 */

import type { PokerAction } from "@fiber-poker/poker-engine";
import { CanonicalReader, CanonicalWriter } from "./canonical.ts";
import { DOMAIN_ACTION, ckbHash } from "./hash.ts";
import { signHash, verifyHash } from "./keys.ts";

export const CLIENT_ACTION_TYPES = [
  "CHECK",
  "CALL",
  "BET",
  "RAISE",
  "FOLD",
  "ALL_IN",
  "LEAVE_REQUEST",
  "ACK_STATE",
] as const;
export type ClientActionType = (typeof CLIENT_ACTION_TYPES)[number];

/** System action types are applied by the authoritative table only. */
export const SYSTEM_ACTION_TYPES = [
  "SIT_DOWN",
  "SIT_IN",
  "SIT_OUT",
  "STAND_UP",
  "TOP_UP",
  "START_HAND",
  "POST_BLIND",
  "TIMEOUT_CHECK",
  "TIMEOUT_FOLD",
  "DISTRIBUTE_POTS",
  "ABORT_HAND",
] as const;
export type SystemActionType = (typeof SYSTEM_ACTION_TYPES)[number];

export interface ActionEnvelope {
  protocolVersion: number;
  tableId: string;
  handId: string;
  /** Decimal string of the expected sequence number (bigint-safe on the wire). */
  sequence: string;
  previousStateHash: string;
  actorPubkey: string;
  actionType: string;
  /** Decimal string of shannons; "0" when the action carries no amount. */
  amountShannons: string;
  /** Optional opaque payload (e.g. join seat number), canonically encoded. */
  payload?: Record<string, string | number>;
  nonce: string;
  signature: string;
}

const AMOUNT_ACTIONS = new Set(["BET", "RAISE"]);

/** Canonical binary encoding of the envelope fields that get hashed/signed. */
export function encodeCanonicalAction(env: {
  protocolVersion: number;
  tableId: string;
  handId: string;
  sequence: bigint;
  previousStateHash: string;
  actorPubkey: string;
  actionType: string;
  amount: bigint;
  payload: string;
  nonce: string;
}): Uint8Array {
  const w = new CanonicalWriter();
  w.domain(DOMAIN_ACTION);
  w.u32(env.protocolVersion);
  w.string(env.tableId);
  w.string(env.handId);
  w.u64(env.sequence);
  w.string(env.previousStateHash);
  w.string(env.actorPubkey);
  w.string(env.actionType);
  w.u64(env.amount);
  w.string(env.payload);
  w.string(env.nonce);
  return w.finish();
}

export function actionHash(env: ActionEnvelope): Uint8Array {
  return ckbHash(
    encodeCanonicalAction({
      protocolVersion: env.protocolVersion,
      tableId: env.tableId,
      handId: env.handId,
      sequence: BigInt(env.sequence),
      previousStateHash: env.previousStateHash,
      actorPubkey: env.actorPubkey,
      actionType: env.actionType,
      amount: BigInt(env.amountShannons || "0"),
      payload: env.payload ? JSON.stringify(env.payload) : "",
      nonce: env.nonce,
    }),
  );
}

/** Build + sign an envelope from an engine action and current chain state. */
export function buildEnvelope(opts: {
  privateKey: string;
  actorPubkey: string;
  tableId: string;
  handId: string;
  sequence: bigint;
  previousStateHash: string;
  action: { type: string; amount?: bigint };
  payload?: Record<string, string | number>;
  nonce: string;
}): ActionEnvelope {
  const env: ActionEnvelope = {
    protocolVersion: 1,
    tableId: opts.tableId,
    handId: opts.handId,
    sequence: opts.sequence.toString(),
    previousStateHash: opts.previousStateHash,
    actorPubkey: opts.actorPubkey,
    actionType: opts.action.type,
    amountShannons: (opts.action.amount ?? 0n).toString(),
    payload: opts.payload,
    nonce: opts.nonce,
    signature: "",
  };
  env.signature = signHash(opts.privateKey, actionHash(env));
  return env;
}

export function verifyEnvelopeSignature(env: ActionEnvelope): boolean {
  if (!env.signature) return false;
  return verifyHash(env.actorPubkey, actionHash(env), env.signature);
}

/** Envelope -> engine action (no signature logic). */
export function envelopeToEngineAction(env: ActionEnvelope): PokerAction {
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
      throw new Error(`envelopeToEngineAction: unsupported type ${env.actionType}`);
  }
}

/**
 * Replay-protection checks that depend only on the envelope and the chain
 * tip (nonce dedup needs server-side session state, see validation.ts).
 */
export function checkEnvelopeAgainstTip(
  env: ActionEnvelope,
  tip: { sequence: bigint; stateHash: string; tableId: string },
): string | undefined {
  if (env.protocolVersion !== 1) return "BAD_PROTOCOL_VERSION";
  if (env.tableId !== tip.tableId) return "WRONG_TABLE";
  let seq: bigint;
  try {
    seq = BigInt(env.sequence);
  } catch {
    return "BAD_SEQUENCE";
  }
  if (seq !== tip.sequence) return seq < tip.sequence ? "STALE_SEQUENCE" : "SEQUENCE_GAP";
  if (env.previousStateHash !== tip.stateHash) return "WRONG_PREVIOUS_STATE_HASH";
  return undefined;
}
