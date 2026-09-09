/**
 * Pure state constructors and lookup helpers for the poker engine.
 */

import { MAX_SEATS, type SeatState, type Shannon, type TableState, type TableConfig } from "./types.ts";

export function emptySeat(seat: number): SeatState {
  return {
    seat,
    playerId: null,
    fiberPubkey: null,
    stack: 0n,
    streetContribution: 0n,
    handContribution: 0n,
    folded: false,
    allIn: false,
    sittingOut: false,
    actedThisStreet: false,
    holeCards: [],
  };
}

export function createTableState(tableId: string, config: TableConfig, previousStateHash = "0".repeat(64)): TableState {
  return {
    protocolVersion: 1,
    tableId,
    handId: "",
    handNo: 0,
    sequence: 0n,
    previousStateHash,
    phase: "WAITING",
    currentBet: 0n,
    minimumRaise: config.bigBlind,
    lastRaiseWasFull: true,
    board: [],
    deck: [],
    seats: Array.from({ length: Math.max(config.maxSeats, 2) }, (_, i) => emptySeat(i)),
    pots: [],
    awards: [],
    config,
  };
}

export function seatByPlayer(state: TableState, playerId: string): SeatState | undefined {
  return state.seats.find((s) => s.playerId === playerId);
}

export function seatByNumber(state: TableState, seat: number): SeatState | undefined {
  return state.seats.find((s) => s.seat === seat);
}

/** Seats occupied by a player who is not sitting out. */
export function activeSeats(state: TableState): SeatState[] {
  return state.seats.filter((s) => s.playerId !== null && !s.sittingOut);
}

/** Players dealt into the current hand (not folded, not sitting out). */
export function liveSeats(state: TableState): SeatState[] {
  return state.seats.filter((s) => s.playerId !== null && s.holeCards.length > 0 && !s.folded);
}

/** Players who can still take a betting action on the current street. */
export function actionableSeats(state: TableState): SeatState[] {
  return liveSeats(state).filter((s) => !s.allIn);
}

/** Next occupied, non-sitting-out seat strictly after `seat`, clockwise. */
export function nextOccupiedSeat(state: TableState, seat: number, requireInHand = false): number | undefined {
  const n = state.seats.length;
  for (let i = 1; i <= n; i++) {
    const s = state.seats[(seat + i) % n];
    if (s && s.playerId !== null && !s.sittingOut) {
      if (requireInHand && (s.holeCards.length === 0 || s.folded)) continue;
      return s.seat;
    }
  }
  return undefined;
}

export function sumStacks(state: TableState): Shannon {
  return state.seats.reduce((acc, s) => acc + s.stack, 0n);
}

export function sumHandContributions(state: TableState): Shannon {
  return state.seats.reduce((acc, s) => acc + s.handContribution, 0n);
}

export function sumPotAmounts(state: TableState): Shannon {
  return state.seats.length > 0
    ? state.pots.reduce((acc, p) => acc + p.amount, 0n) +
        state.awards.reduce((acc, a) => acc + a.amount, 0n)
    : 0n;
}

export const DEFAULT_CONFIG: TableConfig = {
  smallBlind: 1_000_000n, // 0.01 CKB in shannons — devnet friendly
  bigBlind: 2_000_000n, // 0.02 CKB
  maxSeats: MAX_SEATS,
};
