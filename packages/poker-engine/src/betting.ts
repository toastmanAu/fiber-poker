/**
 * Betting-order helpers: legal actions per seat, actor advancement,
 * street transitions. Pure functions over TableState (mutate their argument,
 * which is always a private working clone inside the reducer).
 */

import { deriveSettlement, type SettlementOutcome } from "./pots.ts";
import { actionableSeats, liveSeats } from "./state.ts";
import type { Shannon, TableState } from "./types.ts";

export type LegalAction = "FOLD" | "CHECK" | "CALL" | "BET" | "RAISE" | "ALL_IN";

export interface LegalActions {
  actions: LegalAction[];
  /** Chips this seat must add to match currentBet (capped by stack). */
  callAmount: Shannon;
  /** Minimum legal target for BET/RAISE ("raise to" semantics). */
  minRaiseTo: Shannon;
  /** Maximum legal target (streetContribution + stack). */
  maxRaiseTo: Shannon;
  canRaise: boolean;
}

/** What happened after a betting action completed. */
export type AdvanceResult =
  | { kind: "acted" }
  | { kind: "street"; street: string }
  | { kind: "runout" }
  | { kind: "settlement"; outcome: SettlementOutcome };

export function legalActionsFor(state: TableState, playerId: string): LegalActions {
  const seat = state.seats.find((s) => s.playerId === playerId)!;
  const owed = state.currentBet > seat.streetContribution ? state.currentBet - seat.streetContribution : 0n;
  const callAmount = owed < seat.stack ? owed : seat.stack;
  // A seat may make a full raise if it has not yet acted this street, or the
  // last raise was a full raise that reopened action. A short all-in raise
  // does not reopen betting for seats that already acted.
  const canRaise = !seat.actedThisStreet || state.lastRaiseWasFull;
  const actions: LegalAction[] = ["FOLD", "ALL_IN"];
  if (owed === 0n) {
    actions.push("CHECK");
  } else {
    actions.push("CALL");
  }
  if (canRaise && seat.stack > callAmount) {
    actions.push(state.currentBet === 0n ? "BET" : "RAISE");
  }
  const maxRaiseTo = seat.streetContribution + seat.stack;
  let minRaiseTo: Shannon;
  if (state.currentBet === 0n) {
    minRaiseTo = state.minimumRaise < state.config.bigBlind ? state.config.bigBlind : state.minimumRaise;
  } else {
    minRaiseTo = state.currentBet + state.minimumRaise;
  }
  if (minRaiseTo > maxRaiseTo) minRaiseTo = maxRaiseTo; // only an all-in shove can exceed
  return { actions, callAmount, minRaiseTo, maxRaiseTo, canRaise };
}

export function isActingSeat(state: TableState, playerId: string): boolean {
  return (
    state.actingSeat !== undefined &&
    state.seats.find((s) => s.seat === state.actingSeat)?.playerId === playerId
  );
}

/**
 * Seat the next actor, or finish the street / hand when betting is complete.
 */
export function advanceBetting(state: TableState): AdvanceResult {
  // A hand ends the instant only one live player remains.
  if (liveSeats(state).length <= 1) {
    return finishStreet(state);
  }
  const actors = actionableSeats(state);
  if (actors.length > 0) {
    const startSeat = state.actingSeat ?? state.buttonSeat ?? actors[0]!.seat;
    const n = state.seats.length;
    for (let i = 1; i <= n; i++) {
      const s = state.seats[(startSeat + i) % n];
      if (!s || s.playerId === null || s.folded || s.allIn || s.holeCards.length === 0) continue;
      const needs = !s.actedThisStreet || s.streetContribution < state.currentBet;
      if (needs) {
        state.actingSeat = s.seat;
        return { kind: "acted" };
      }
    }
  }
  return finishStreet(state);
}

/** Everyone has acted and matched: close the street. */
function finishStreet(state: TableState): AdvanceResult {
  const live = liveSeats(state);
  if (live.length <= 1) {
    return { kind: "settlement", outcome: enterSettlement(state) };
  }
  if (state.street === "RIVER") {
    // River betting complete: proceed to showdown.
    return { kind: "settlement", outcome: enterSettlement(state) };
  }
  const owing = live.some((s) => s.streetContribution < state.currentBet);
  const canAct = actionableSeats(state);
  if (canAct.length === 0 || (!owing && canAct.length <= 1)) {
    // No point betting further: run the board out deterministically.
    runOutBoard(state);
    return { kind: "settlement", outcome: enterSettlement(state) };
  }
  const street = dealNextStreet(state);
  state.actingSeat = firstToActPostflop(state);
  return { kind: "street", street };
}

/** Deal the next street's cards and reset per-street betting state. */
function dealNextStreet(state: TableState): string {
  for (const s of liveSeats(state)) {
    s.streetContribution = 0n;
    s.actedThisStreet = false;
  }
  state.currentBet = 0n;
  state.minimumRaise = state.config.bigBlind;
  state.lastRaiseWasFull = true;

  const deal = (count: number): void => {
    for (let i = 0; i < count; i++) {
      const card = state.deck.shift();
      if (card === undefined) throw new Error("deck exhausted");
      state.board.push(card);
    }
  };

  if (state.street === "PREFLOP") {
    state.street = "FLOP";
    deal(3);
  } else if (state.street === "FLOP") {
    state.street = "TURN";
    deal(1);
  } else if (state.street === "TURN") {
    state.street = "RIVER";
    deal(1);
  } else {
    throw new Error(`dealNextStreet called in street ${state.street}`);
  }
  return state.street;
}

/** Deal every remaining board card (all-in runout). */
function runOutBoard(state: TableState): void {
  for (const s of liveSeats(state)) s.streetContribution = 0n;
  while (state.board.length < 5) {
    const card = state.deck.shift();
    if (card === undefined) throw new Error("deck exhausted during runout");
    state.board.push(card);
    if (state.board.length === 3) state.street = "FLOP";
    else if (state.board.length === 4) state.street = "TURN";
    else state.street = "RIVER";
  }
}

export function firstToActPostflop(state: TableState): number {
  const start = state.buttonSeat ?? -1;
  const n = state.seats.length;
  for (let i = 1; i <= n; i++) {
    const s = state.seats[(start + i) % n];
    if (s && s.playerId !== null && s.holeCards.length > 0 && !s.folded && !s.allIn) return s.seat;
  }
  // Nobody can act (should have been a runout); fall back to first live seat.
  return liveSeats(state)[0]!.seat;
}

/** Derive pots/awards, flip the state into SETTLEMENT. Returns the outcome. */
export function enterSettlement(state: TableState): SettlementOutcome {
  const outcome = deriveSettlement(state);
  state.pots = outcome.pots;
  state.awards = outcome.awards;
  state.street = "SHOWDOWN";
  state.phase = "SETTLEMENT";
  state.actingSeat = undefined;
  state.currentBet = 0n;
  return outcome;
}
