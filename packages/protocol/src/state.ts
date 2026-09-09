/**
 * Canonical public state view + the state hash chain.
 *
 * The hash chain is computed over the PUBLIC projection of TableState:
 *  - hole cards are replaced by per-seat commitments (H over the cards),
 *  - the undealt deck is omitted (the deck commitment binds it instead).
 *
 * This means every client can verify every state hash in real time from
 * public data alone, and after the post-hand deck reveal can additionally
 * reconstruct the whole hand and verify the hole-card commitments.
 */

import type { TableState } from "@fiber-poker/poker-engine";
import { CanonicalWriter } from "./canonical.ts";
import { DOMAIN_HOLE_CARDS, DOMAIN_STATE, ckbHash } from "./hash.ts";

export interface PublicSeat {
  seat: number;
  playerId: string | null;
  fiberPubkey: string | null;
  stack: string;
  streetContribution: string;
  handContribution: string;
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  actedThisStreet: boolean;
  /** "0x"-less hex commitment of the private hole cards; undefined when none. */
  holeCardsHash?: string;
}

export interface PublicTableState {
  protocolVersion: number;
  tableId: string;
  handId: string;
  handNo: number;
  sequence: string;
  phase: string;
  street?: string;
  buttonSeat?: number;
  smallBlindSeat?: number;
  bigBlindSeat?: number;
  actingSeat?: number;
  currentBet: string;
  minimumRaise: string;
  lastRaiseWasFull: boolean;
  board: number[];
  deckCommitment?: string;
  seats: PublicSeat[];
  pots: { potId: number; amount: string; eligiblePlayerIds: string[] }[];
  awards: { playerId: string; amount: string; potIds: number[]; oddChips: string }[];
  config: { smallBlind: string; bigBlind: string; maxSeats: number };
  aborted?: boolean;
  abortReason?: string;
}

/** Commitment over a seat's private hole cards (post-hand auditable). */
export function holeCardsHash(handId: string, cards: readonly number[]): string | undefined {
  if (cards.length === 0) return undefined;
  const w = new CanonicalWriter();
  w.domain(DOMAIN_HOLE_CARDS);
  w.string(handId);
  w.u8Array(cards);
  return toHexSafe(ckbHash(w.finish()));
}

function toHexSafe(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Project the full engine state to its public, canonical-hashed view. */
export function publicView(state: TableState): PublicTableState {
  return {
    protocolVersion: state.protocolVersion,
    tableId: state.tableId,
    handId: state.handId,
    handNo: state.handNo,
    sequence: state.sequence.toString(),
    phase: state.phase,
    street: state.street,
    buttonSeat: state.buttonSeat,
    smallBlindSeat: state.smallBlindSeat,
    bigBlindSeat: state.bigBlindSeat,
    actingSeat: state.actingSeat,
    currentBet: state.currentBet.toString(),
    minimumRaise: state.minimumRaise.toString(),
    lastRaiseWasFull: state.lastRaiseWasFull,
    board: state.board.slice(),
    deckCommitment: state.deckCommitment,
    seats: state.seats.map((s) => ({
      seat: s.seat,
      playerId: s.playerId,
      fiberPubkey: s.fiberPubkey,
      stack: s.stack.toString(),
      streetContribution: s.streetContribution.toString(),
      handContribution: s.handContribution.toString(),
      folded: s.folded,
      allIn: s.allIn,
      sittingOut: s.sittingOut,
      actedThisStreet: s.actedThisStreet,
      holeCardsHash: holeCardsHash(state.handId, s.holeCards),
    })),
    pots: state.pots.map((p) => ({
      potId: p.potId,
      amount: p.amount.toString(),
      eligiblePlayerIds: [...p.eligiblePlayerIds],
    })),
    awards: state.awards.map((a) => ({
      playerId: a.playerId,
      amount: a.amount.toString(),
      potIds: [...a.potIds],
      oddChips: a.oddChips.toString(),
    })),
    config: {
      smallBlind: state.config.smallBlind.toString(),
      bigBlind: state.config.bigBlind.toString(),
      maxSeats: state.config.maxSeats,
    },
    aborted: state.aborted,
    abortReason: state.abortReason,
  };
}

/** Canonical binary encoding of a public state view. Field order is FROZEN. */
export function encodeCanonicalState(v: PublicTableState): Uint8Array {
  const w = new CanonicalWriter();
  w.domain(DOMAIN_STATE);
  w.u32(v.protocolVersion);
  w.string(v.tableId);
  w.string(v.handId);
  w.u64(BigInt(v.handNo));
  w.string(v.sequence);
  w.string(v.phase);
  w.optionalString(v.street);
  w.optionalU8(v.buttonSeat);
  w.optionalU8(v.smallBlindSeat);
  w.optionalU8(v.bigBlindSeat);
  w.optionalU8(v.actingSeat);
  w.u64(BigInt(v.currentBet));
  w.u64(BigInt(v.minimumRaise));
  w.bool(v.lastRaiseWasFull);
  w.u8Array(v.board);
  w.optionalString(v.deckCommitment);
  w.u32(v.seats.length);
  for (const s of v.seats) {
    w.u8(s.seat);
    w.optionalString(s.playerId);
    w.optionalString(s.fiberPubkey);
    w.u64(BigInt(s.stack));
    w.u64(BigInt(s.streetContribution));
    w.u64(BigInt(s.handContribution));
    w.bool(s.folded);
    w.bool(s.allIn);
    w.bool(s.sittingOut);
    w.bool(s.actedThisStreet);
    w.optionalString(s.holeCardsHash);
  }
  w.u32(v.pots.length);
  for (const p of v.pots) {
    w.u32(p.potId);
    w.u64(BigInt(p.amount));
    w.stringArray(p.eligiblePlayerIds);
  }
  w.u32(v.awards.length);
  for (const a of v.awards) {
    w.string(a.playerId);
    w.u64(BigInt(a.amount));
    w.stringArray(a.potIds.map(String));
    w.u64(BigInt(a.oddChips));
  }
  w.u64(BigInt(v.config.smallBlind));
  w.u64(BigInt(v.config.bigBlind));
  w.u8(v.config.maxSeats);
  w.bool(v.aborted === true);
  w.optionalString(v.abortReason);
  return w.finish();
}

const ZERO32 = new Uint8Array(32);

/** stateHash[n+1] = H(DOMAIN_STATE || stateHash[n] || actionHash || canonicalState). */
export function nextStateHash(
  previousStateHashHex: string,
  actionHashHex: string,
  view: PublicTableState,
): string {
  return toHexSafe(
    ckbHash(
      new CanonicalWriter().domain(DOMAIN_STATE).finish(),
      fromHexSafe(previousStateHashHex),
      fromHexSafe(actionHashHex),
      encodeCanonicalState(view),
    ),
  );
}

/**
 * Genesis hash for a fresh table: chained from a zero previous hash and a
 * zero action hash so the very first committed action verifies.
 */
export function genesisStateHash(view: PublicTableState): string {
  return toHexSafe(
    ckbHash(
      new CanonicalWriter().domain(DOMAIN_STATE).finish(),
      ZERO32,
      ZERO32,
      encodeCanonicalState(view),
    ),
  );
}

function fromHexSafe(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Verify a state hash against the chain inputs (client-side audit). */
export function verifyStateHash(
  previousStateHashHex: string,
  actionHashHex: string,
  stateHashHex: string,
  view: PublicTableState,
): boolean {
  return nextStateHash(previousStateHashHex, actionHashHex, view) === stateHashHex;
}
