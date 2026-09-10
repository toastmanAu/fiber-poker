/**
 * WebSocket message contracts (docs/05 + schemas/ws-message.schema.json).
 *
 * Every message: { type, protocolVersion, messageId, tableId?, handId?,
 * sequence?, payload }. Money fields are decimal strings; never numbers.
 */

import type { PublicTableState } from "./state.ts";

export const PROTOCOL_VERSION = 1;

export interface WsMessage<T = Record<string, unknown>> {
  type: string;
  protocolVersion: number;
  messageId: string;
  tableId?: string | null;
  handId?: string | null;
  sequence?: string | null;
  payload: T;
}

// --- client -> server -------------------------------------------------------
export type ClientMessageType =
  | "HELLO" // { pubkey, sessionToken? } (starts auth)
  | "AUTH_RESPONSE" // { challengeId, signature }
  | "JOIN_TABLE" // { seat?, buyInShannons, autoPay? }
  | "READY" // {} client ready to receive play
  | "ACTION" // { envelope: ActionEnvelope }
  | "LEAVE_REQUEST" // {}
  | "SIT_IN" | "SIT_OUT" // {}
  | "ACK_STATE" // { stateHash, sequence }
  | "SEED_COMMIT" // { handId, commitment } (P10 multiparty seed protocol)
  | "SEED_REVEAL" // { handId, seed } (hex, 32 bytes)
  | "RESYNC" // { lastSequence, lastStateHash? } reconnect support
  | "PING" // {}
  | "DECK_AUDIT"; // { handId } request reveal verification material

// --- server -> client -------------------------------------------------------
export type ServerMessageType =
  | "WELCOME" // { tablePubkey, protocolVersion, sessionId }
  | "AUTH_CHALLENGE" // { challengeId, challenge (hex to sign) }
  | "AUTH_OK" // { playerId }
  | "AUTH_FAILED" // { reason }
  | "TABLE_SNAPSHOT" // { state: PublicTableState, seats: SeatStatus[] }
  | "PLAYER_JOINED" // { playerId, seat }
  | "PLAYER_LEFT" // { playerId, seat }
  | "SEAT_STATUS" // { playerId, phase } lifecycle transitions
  | "CHANNEL_STATUS" // { playerId, channelId?, state, balances? }
  | "HAND_START" // { handId, deckCommitment, buttonSeat, state }
  | "SEED_COMMITMENT_REQUEST" // { handId, deadlineUnixMs } (P10)
  | "SEED_REVEAL_REQUEST" // { handId, deadlineUnixMs } (P10)
  | "HOLE_CARDS" // { cards: string[] } (TARGETED: this connection only)
  | "YOUR_TURN" // { legalActions, callAmount, minRaiseTo, maxRaiseTo, deadlineUnixMs }
  | "PAYMENT_REQUIRED" // { paymentHash, amountShannons, reason, obligationId, invoice? } (TARGETED)
  | "PAYMENT_STATUS" // { paymentHash, status, obligationId }
  | "ACTION_ACCEPTED" // { actionHash, sequence }
  | "ACTION_REJECTED" // { actionHash?, code, detail }
  | "STATE_COMMIT" // { sequence, actionHash, previousStateHash, stateHash, summary, signature, state: PublicTableState }
  | "STREET_CHANGED" // { street }
  | "HAND_RESULT" // { handId, awards, refunds, board, showdowns: {playerId, cards}[] }
  | "DECK_REVEALED" // { handId, permutation, nonce, commitment } (audit material)
  | "TIMER" // { kind: "TURN_STARTED", deadlineUnixMs, actingSeat }
  | "ERROR" // { code, detail }
  | "PONG" // {}
  | "SERVER_CLOSING"; // { reason }

export interface SeatStatus {
  playerId: string;
  seat: number;
  /** Player lifecycle: DISCONNECTED | CONNECTED | CHANNEL_NEGOTIATING |
   *  CHANNEL_READY | LIQUIDITY_CHECK | SEAT_READY | PLAYING | LEAVE_PENDING | CLOSING */
  lifecycle: string;
  connected: boolean;
  sittingOut: boolean;
}

export function makeMessage<T>(type: string, payload: T, extra?: Partial<WsMessage>): WsMessage<T> {
  return {
    type,
    protocolVersion: PROTOCOL_VERSION,
    messageId: `${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`,
    ...extra,
    payload: payload as Record<string, unknown> as T,
  };
}

/** Public snapshot payload (state + per-seat lifecycle status). */
export interface SnapshotPayload {
  state: PublicTableState;
  seats: SeatStatus[];
  /** DEV ONLY surfaces: fake-settlement mode banner. */
  devMode?: { autoPay: boolean; fakeSettlement: boolean };
}
