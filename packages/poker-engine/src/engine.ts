/**
 * The deterministic NLHE table reducer.
 *
 * Pure: no IO, no clock, no RNG, no floating point, no network state.
 * Cards enter as explicit input (START_HAND deck). Timeouts enter as
 * explicit TIMEOUT_* actions. Money is bigint shannons.
 *
 * The reducer NEVER commits value by itself: every value-changing player
 * action produces EconomicObligations that the table's SettlementCoordinator
 * must fulfil over Fiber BEFORE the resulting state is committed to the
 * hash chain (payment-before-commit). System actions (START_HAND,
 * POST_BLIND, DISTRIBUTE_POTS, ABORT_HAND, TIMEOUT_*) are applied by the
 * authoritative table only, after the corresponding settlement resolves.
 */

import {
  advanceBetting,
  enterSettlement,
  isActingSeat,
  legalActionsFor,
  type AdvanceResult,
} from "./betting.ts";
import { DECK_SIZE } from "./cards.ts";
import { deriveSettlement, settlementObligations, type SettlementOutcome } from "./pots.ts";
import { activeSeats, createTableState, seatByPlayer } from "./state.ts";
import {
  PokerError,
  type EconomicObligation,
  type PokerAction,
  type PokerTransition,
  type ReduceResult,
  type SeatState,
  type Shannon,
  type TableState,
} from "./types.ts";

export class FiberPokerEngine {
  /**
   * Apply `action` to an immutable `state`.
   * Deterministic: same (state, action) => same result, always.
   */
  reduce(state: TableState, action: PokerAction): ReduceResult {
    try {
      const next = structuredClone(state);
      const outcome = applyAction(next, action);
      const transition: PokerTransition = {
        nextState: next,
        obligations: outcome.obligations,
        summary: outcome.summary,
      };
      return { ok: true, transition };
    } catch (e) {
      if (e instanceof PokerError) return { ok: false, error: e };
      throw e;
    }
  }

  /**
   * Validate without committing. The SettlementCoordinator uses this to check
   * rule legality BEFORE planning any payment.
   */
  validate(state: TableState, action: PokerAction): PokerError | undefined {
    try {
      applyAction(structuredClone(state), action);
      return undefined;
    } catch (e) {
      if (e instanceof PokerError) return e;
      throw e;
    }
  }

  /** Legal actions for a player right now (UI + timeout policy). */
  legalActions(state: TableState, playerId: string) {
    const seat = seatByPlayer(state, playerId);
    if (!seat) return undefined;
    if (state.phase === "WAITING" || state.phase === "HAND_COMPLETE") {
      return {
        phase: state.phase,
        actions: seat.sittingOut ? (["SIT_IN"] as const) : (["SIT_OUT"] as const),
        callAmount: 0n,
      };
    }
    if (seat.holeCards.length === 0 || seat.folded || seat.allIn) {
      return { phase: state.phase, actions: [] as const, callAmount: 0n };
    }
    if (isActingSeat(state, playerId)) {
      return { phase: state.phase, ...legalActionsFor(state, playerId) };
    }
    return { phase: state.phase, actions: [] as const, callAmount: 0n };
  }
}

interface ApplyOutcome {
  obligations: EconomicObligation[];
  summary: string;
}

function applyAction(state: TableState, action: PokerAction): ApplyOutcome {
  state.sequence += 1n;
  switch (action.type) {
    case "SIT_DOWN":
      return sitDown(state, action.playerId, action.fiberPubkey, action.seat, action.buyIn);
    case "SIT_IN":
      return sitInOut(state, action.playerId, false);
    case "SIT_OUT":
      return sitInOut(state, action.playerId, true);
    case "STAND_UP":
      return standUp(state, action.playerId);
    case "START_HAND":
      return startHand(state, action);
    case "POST_BLIND":
      return postBlind(state, action.playerId);
    case "CHECK":
    case "TIMEOUT_CHECK":
      return playerCheck(state, action.playerId, action.type === "TIMEOUT_CHECK");
    case "CALL":
      return playerCall(state, action.playerId);
    case "BET":
    case "RAISE":
      return playerRaise(state, action.playerId, action.amount, action.type);
    case "FOLD":
    case "TIMEOUT_FOLD":
      return playerFold(state, action.playerId, action.type === "TIMEOUT_FOLD");
    case "ALL_IN":
      return playerAllIn(state, action.playerId);
    case "DISTRIBUTE_POTS":
      return distributePots(state);
    case "ABORT_HAND":
      return abortHand(state, action.reason);
  }
}

/**
 * Merge the payout/refund obligations produced when a betting action ends
 * the hand (fold-win or all-in runout) into the action's own obligations.
 */
function obligationsForAdvance(
  state: TableState,
  base: EconomicObligation[],
  advance: AdvanceResult,
): EconomicObligation[] {
  if (advance.kind === "settlement") {
    return [...base, ...settlementObligations(state.handId, state.sequence, advance.outcome)];
  }
  return base;
}

function describeAdvance(advance: AdvanceResult): string {
  switch (advance.kind) {
    case "acted":
      return "next_actor";
    case "street":
      return `street_${advance.street}`;
    case "runout":
      return "runout";
    case "settlement":
      return "hand_end";
  }
}

// ---------------------------------------------------------------------------
// Seat lifecycle (between hands only)
// ---------------------------------------------------------------------------

function requireBetweenHands(state: TableState): void {
  if (state.phase !== "WAITING" && state.phase !== "HAND_COMPLETE") {
    throw new PokerError("WRONG_PHASE", `seat changes only between hands, phase=${state.phase}`);
  }
}

function sitDown(state: TableState, playerId: string, fiberPubkey: string, seat: number, buyIn: Shannon): ApplyOutcome {
  requireBetweenHands(state);
  if (seat < 0 || seat >= state.seats.length) throw new PokerError("SEAT_TAKEN", `seat ${seat} out of range`);
  if (seatByPlayer(state, playerId)) throw new PokerError("ALREADY_IN_HAND", `player ${playerId} already seated`);
  const target = state.seats[seat]!;
  if (target.playerId !== null) throw new PokerError("SEAT_TAKEN", `seat ${seat} occupied`);
  if (buyIn <= 0n) throw new PokerError("INVALID_AMOUNT", "buyIn must be positive");
  target.playerId = playerId;
  target.fiberPubkey = fiberPubkey;
  target.stack = buyIn;
  target.sittingOut = false;
  return { obligations: [], summary: `sit_down:${playerId}:seat${seat}` };
}

function standUp(state: TableState, playerId: string): ApplyOutcome {
  requireBetweenHands(state);
  const seat = seatByPlayer(state, playerId);
  if (!seat) throw new PokerError("NOT_SEATED", `player ${playerId} not seated`);
  if (seat.holeCards.length > 0) throw new PokerError("WRONG_PHASE", "cannot stand up mid-hand");
  seat.playerId = null;
  seat.fiberPubkey = null;
  seat.stack = 0n;
  seat.streetContribution = 0n;
  seat.handContribution = 0n;
  seat.folded = false;
  seat.allIn = false;
  seat.actedThisStreet = false;
  seat.holeCards = [];
  return { obligations: [], summary: `stand_up:${playerId}` };
}

function sitInOut(state: TableState, playerId: string, out: boolean): ApplyOutcome {
  requireBetweenHands(state);
  const seat = seatByPlayer(state, playerId);
  if (!seat) throw new PokerError("NOT_SEATED", `player ${playerId} not seated`);
  if (seat.sittingOut === out) {
    return { obligations: [], summary: `noop:sit_${out ? "out" : "in"}:${playerId}` };
  }
  seat.sittingOut = out;
  return { obligations: [], summary: `sit_${out ? "out" : "in"}:${playerId}` };
}

// ---------------------------------------------------------------------------
// Hand lifecycle
// ---------------------------------------------------------------------------

function startHand(state: TableState, action: Extract<PokerAction, { type: "START_HAND" }>): ApplyOutcome {
  if (state.phase !== "WAITING" && state.phase !== "HAND_COMPLETE") {
    throw new PokerError("WRONG_PHASE", `cannot start hand from phase=${state.phase}`);
  }
  if (!action.handId) throw new PokerError("INVALID_DECK", "handId required");
  if (action.deck.length !== DECK_SIZE) throw new PokerError("INVALID_DECK", `deck must have ${DECK_SIZE} cards`);
  if (new Set(action.deck).size !== DECK_SIZE) throw new PokerError("INVALID_DECK", "deck cards must be unique");
  if (action.deck.some((c) => c < 0 || c >= DECK_SIZE || !Number.isInteger(c))) {
    throw new PokerError("INVALID_DECK", "deck card out of range");
  }
  if (!action.deckCommitment) throw new PokerError("INVALID_DECK", "deckCommitment required");

  const eligible = activeSeats(state).filter((s) => s.stack > 0n);
  if (eligible.length < 2) throw new PokerError("NOT_ENOUGH_PLAYERS", "need at least 2 eligible players");

  state.handNo += 1;
  state.handId = action.handId;
  state.aborted = false;
  state.abortReason = undefined;
  state.deck = [...action.deck];
  state.deckCommitment = action.deckCommitment;
  state.board = [];
  state.pots = [];
  state.awards = [];

  // Rotate the button to the next eligible seat clockwise (first hand: lowest seat).
  const eligibleSeats = eligible.map((s) => s.seat).sort((a, b) => a - b);
  let button = eligibleSeats[0]!;
  if (state.buttonSeat !== undefined) {
    const n = state.seats.length;
    for (let i = 1; i <= n; i++) {
      const s = state.seats[(state.buttonSeat + i) % n];
      if (s && eligibleSeats.includes(s.seat)) {
        button = s.seat;
        break;
      }
    }
  }
  state.buttonSeat = button;

  const nextEligible = (from: number): number => {
    const n = state.seats.length;
    for (let i = 1; i <= n; i++) {
      const s = state.seats[(from + i) % n];
      if (s && eligibleSeats.includes(s.seat)) return s.seat;
    }
    throw new PokerError("NOT_ENOUGH_PLAYERS", "cannot seat blinds");
  };

  const headsUp = eligibleSeats.length === 2;
  // Heads-up: the button posts the small blind and acts first preflop.
  const sbSeat = headsUp ? button : nextEligible(button);
  const bbSeat = nextEligible(sbSeat);
  state.smallBlindSeat = sbSeat;
  state.bigBlindSeat = bbSeat;

  // Reset per-hand state for every seat.
  for (const s of state.seats) {
    s.streetContribution = 0n;
    s.handContribution = 0n;
    s.folded = false;
    s.allIn = false;
    s.actedThisStreet = false;
    s.holeCards = [];
  }

  state.currentBet = state.config.bigBlind;
  state.minimumRaise = state.config.bigBlind;
  state.lastRaiseWasFull = true;
  state.street = undefined;
  state.phase = "POST_SMALL_BLIND";
  state.actingSeat = sbSeat;

  const sbSeatState = state.seats[sbSeat]!;
  const sbAmount = minOf(sbSeatState.stack, state.config.smallBlind);
  return {
    obligations: [
      {
        kind: "PAY_TABLE",
        playerId: sbSeatState.playerId!,
        amount: sbAmount,
        reason: "SMALL_BLIND",
        obligationId: `${state.handId}:${state.sequence}:SMALL_BLIND:${sbSeatState.playerId}`,
      },
    ],
    summary: `hand_start:${state.handId}:players${eligibleSeats.length}:button${button}`,
  };
}

function minOf(a: Shannon, b: Shannon): Shannon {
  return a < b ? a : b;
}

function postBlind(state: TableState, playerId: string): ApplyOutcome {
  const expected =
    state.phase === "POST_SMALL_BLIND"
      ? state.smallBlindSeat
      : state.phase === "POST_BIG_BLIND"
        ? state.bigBlindSeat
        : undefined;
  if (expected === undefined) throw new PokerError("WRONG_PHASE", `no blind due in phase=${state.phase}`);
  const seat = state.seats[expected]!;
  if (seat.playerId !== playerId) throw new PokerError("WRONG_BLIND_SEAT", `expected blind from seat ${expected}`);
  if (seat.holeCards.length > 0) throw new PokerError("ALREADY_IN_HAND", "blind already posted");

  const required = state.phase === "POST_SMALL_BLIND" ? state.config.smallBlind : state.config.bigBlind;
  const pay = minOf(seat.stack, required);
  commitChips(state, seat, pay);

  if (state.phase === "POST_SMALL_BLIND") {
    seat.actedThisStreet = true;
    state.phase = "POST_BIG_BLIND";
    state.actingSeat = state.bigBlindSeat!;
    const bbSeatState = state.seats[state.bigBlindSeat!]!;
    const bbAmount = minOf(bbSeatState.stack, state.config.bigBlind);
    return {
      obligations: [
        {
          kind: "PAY_TABLE",
          playerId: bbSeatState.playerId!,
          amount: bbAmount,
          reason: "BIG_BLIND",
          obligationId: `${state.handId}:${state.sequence}:BIG_BLIND:${bbSeatState.playerId}`,
        },
      ],
      summary: `post_sb:${playerId}:${pay}`,
    };
  }

  // Big blind posted. The BB keeps the preflop option (check or raise) even
  // when everyone has just called, so leave actedThisStreet false unless the
  // blind put the seat all-in.
  if (!seat.allIn) seat.actedThisStreet = false;

  // Big blind posted: deal hole cards and open PREFLOP betting.
  dealHoleCards(state);
  state.phase = "PREFLOP";
  state.street = "PREFLOP";
  state.actingSeat = firstToActPreflop(state);
  // A hand where everyone but one is already all-in (tiny stacks) resolves
  // immediately through the normal betting-completion path.
  const canAct = state.seats.filter((s) => s.holeCards.length > 0 && !s.folded && !s.allIn);
  let advanceSummary = "";
  let obligations: EconomicObligation[] = [];
  if (canAct.length <= 1) {
    const advance = advanceBetting(state);
    advanceSummary = `:${describeAdvance(advance)}`;
    obligations = obligationsForAdvance(state, obligations, advance);
  }
  return {
    obligations,
    summary: `post_bb:${playerId}:${pay}${advanceSummary}`,
  };
}

/**
 * Deal two cards to every dealt-in player, one round at a time, clockwise
 * from the small blind. Dealt-in = was eligible at START_HAND, which is
 * exactly: seated, not sitting out, and still holding chips or already
 * having posted chips toward this hand.
 */
function dealHoleCards(state: TableState): void {
  const n = state.seats.length;
  const start = state.smallBlindSeat!;
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = state.seats[(start + i) % n];
    if (s && s.playerId !== null && !s.sittingOut && (s.stack > 0n || s.handContribution > 0n)) {
      order.push(s.seat);
    }
  }
  for (let round = 0; round < 2; round++) {
    for (const seatNo of order) {
      const card = state.deck.shift();
      if (card === undefined) throw new Error("deck exhausted dealing hole cards");
      state.seats[seatNo]!.holeCards.push(card);
    }
  }
}

function firstToActPreflop(state: TableState): number {
  const dealtIn = state.seats.filter((s) => s.holeCards.length > 0).map((s) => s.seat);
  if (dealtIn.length === 2) return state.smallBlindSeat!;
  const n = state.seats.length;
  for (let i = 1; i <= n; i++) {
    const s = state.seats[(state.bigBlindSeat! + i) % n];
    if (s && dealtIn.includes(s.seat)) return s.seat;
  }
  throw new PokerError("NOT_ENOUGH_PLAYERS", "no preflop actor");
}

// ---------------------------------------------------------------------------
// Betting actions
// ---------------------------------------------------------------------------

function requireBettingPhase(state: TableState): void {
  if (state.phase !== "PREFLOP" && state.phase !== "FLOP" && state.phase !== "TURN" && state.phase !== "RIVER") {
    throw new PokerError("WRONG_PHASE", `no betting in phase=${state.phase}`);
  }
}

function requireActor(state: TableState, playerId: string, system = false): SeatState {
  requireBettingPhase(state);
  const seat = state.seats.find((s) => s.playerId === playerId);
  if (!seat) throw new PokerError("NOT_SEATED", `player ${playerId} not seated`);
  if (seat.holeCards.length === 0) throw new PokerError("FOLDED", `player ${playerId} not in hand`);
  if (seat.folded) throw new PokerError("FOLDED", `player ${playerId} already folded`);
  if (seat.allIn) throw new PokerError("ALL_IN_SEAT", `player ${playerId} is all-in`);
  if (!system && !isActingSeat(state, playerId)) {
    throw new PokerError("OUT_OF_TURN", `not ${playerId}'s turn`);
  }
  return seat;
}

/** Move chips from stack into street/hand contribution. */
function commitChips(state: TableState, seat: SeatState, amount: Shannon): void {
  if (amount <= 0n) return;
  if (amount > seat.stack) {
    throw new PokerError("INSUFFICIENT_FUNDS", `seat ${seat.seat} stack ${seat.stack} < ${amount}`);
  }
  seat.stack -= amount;
  seat.streetContribution += amount;
  seat.handContribution += amount;
  if (seat.stack === 0n) seat.allIn = true;
}

function paymentObligation(
  state: TableState,
  playerId: string,
  amount: Shannon,
  reason: EconomicObligation["reason"],
): EconomicObligation {
  return {
    kind: "PAY_TABLE",
    playerId,
    amount,
    reason,
    obligationId: `${state.handId}:${state.sequence}:${reason}:${playerId}`,
  };
}

function playerCheck(state: TableState, playerId: string, timeout: boolean): ApplyOutcome {
  const seat = requireActor(state, playerId, timeout);
  const legal = legalActionsFor(state, playerId);
  if (!legal.actions.includes("CHECK")) {
    throw new PokerError("ILLEGAL_CHECK", "cannot check facing a bet");
  }
  seat.actedThisStreet = true;
  const advance = advanceBetting(state);
  return {
    obligations: obligationsForAdvance(state, [], advance),
    summary: `${timeout ? "timeout_check" : "check"}:${playerId}:${describeAdvance(advance)}`,
  };
}

function playerCall(state: TableState, playerId: string): ApplyOutcome {
  const seat = requireActor(state, playerId);
  const legal = legalActionsFor(state, playerId);
  const pay = legal.callAmount;
  commitChips(state, seat, pay);
  seat.actedThisStreet = true;
  const advance = advanceBetting(state);
  const base = pay > 0n ? [paymentObligation(state, playerId, pay, "CALL")] : [];
  return {
    obligations: obligationsForAdvance(state, base, advance),
    summary: `${pay > 0n ? "call" : "check"}:${playerId}:${pay}:${describeAdvance(advance)}`,
  };
}

function playerRaise(
  state: TableState,
  playerId: string,
  amount: Shannon,
  actionKind: "BET" | "RAISE",
): ApplyOutcome {
  const seat = requireActor(state, playerId);
  if (amount <= 0n) throw new PokerError("INVALID_AMOUNT", "amount must be positive");
  const legal = legalActionsFor(state, playerId);
  const maxTo = legal.maxRaiseTo; // streetContribution + stack
  const isAllInAmount = amount === maxTo;

  if (state.currentBet === 0n) {
    // Opening bet: at least one big blind unless the wager is an all-in.
    if (amount < state.config.bigBlind && !isAllInAmount) {
      throw new PokerError("AMOUNT_TOO_SMALL", `minimum bet is ${state.config.bigBlind}`);
    }
  } else {
    if (amount <= state.currentBet) {
      throw new PokerError("AMOUNT_TOO_SMALL", `raise to ${amount} must exceed current bet ${state.currentBet}`);
    }
    const increment = amount - state.currentBet;
    if (increment < state.minimumRaise && !isAllInAmount) {
      throw new PokerError("AMOUNT_TOO_SMALL", `raise increment must be >= ${state.minimumRaise}`);
    }
  }
  if (amount > maxTo) {
    throw new PokerError("AMOUNT_TOO_LARGE", `cannot wager more than stack (${maxTo} max)`);
  }
  // Normalize BET/RAISE against the current table state.
  const kind: "BET" | "RAISE" = state.currentBet === 0n ? "BET" : "RAISE";

  const previousBet = state.currentBet;
  const wasFullRaise =
    previousBet === 0n ? amount >= state.config.bigBlind : amount - previousBet >= state.minimumRaise;

  const pay = amount - seat.streetContribution;
  commitChips(state, seat, pay);
  state.currentBet = amount;
  if (wasFullRaise) {
    state.minimumRaise = amount - previousBet;
    state.lastRaiseWasFull = true;
    // A full raise reopens action for every other live, non-all-in seat.
    for (const s of state.seats) {
      if (s.playerId !== null && s.holeCards.length > 0 && !s.folded && !s.allIn && s.seat !== seat.seat) {
        s.actedThisStreet = false;
      }
    }
  } else {
    // Short all-in raise: raises the amount to call but does NOT reopen
    // betting for players who already acted.
    state.lastRaiseWasFull = false;
  }
  seat.actedThisStreet = true;
  const advance = advanceBetting(state);
  const base = pay > 0n ? [paymentObligation(state, playerId, pay, kind === "BET" ? "BET" : "RAISE")] : [];
  return {
    obligations: obligationsForAdvance(state, base, advance),
    summary: `${kind.toLowerCase()}:${playerId}:to${amount}:${describeAdvance(advance)}`,
  };
}

function playerFold(state: TableState, playerId: string, timeout: boolean): ApplyOutcome {
  const seat = requireActor(state, playerId, timeout);
  seat.folded = true;
  seat.actedThisStreet = true;
  const advance = advanceBetting(state);
  return {
    obligations: obligationsForAdvance(state, [], advance),
    summary: `${timeout ? "timeout_fold" : "fold"}:${playerId}:${describeAdvance(advance)}`,
  };
}

function playerAllIn(state: TableState, playerId: string): ApplyOutcome {
  const seat = requireActor(state, playerId);
  if (seat.stack === 0n) throw new PokerError("ALL_IN_SEAT", "already all-in");
  const pay = seat.stack;
  const previousBet = state.currentBet;
  commitChips(state, seat, pay);
  const newTotal = seat.streetContribution;

  let reason: EconomicObligation["reason"] = "CALL";
  if (newTotal > previousBet) {
    reason = previousBet === 0n ? "BET" : "RAISE";
    const wasFullRaise =
      previousBet === 0n ? newTotal >= state.config.bigBlind : newTotal - previousBet >= state.minimumRaise;
    state.currentBet = newTotal;
    if (wasFullRaise) {
      state.minimumRaise = newTotal - previousBet;
      state.lastRaiseWasFull = true;
      for (const s of state.seats) {
        if (s.playerId !== null && s.holeCards.length > 0 && !s.folded && !s.allIn && s.seat !== seat.seat) {
          s.actedThisStreet = false;
        }
      }
    } else {
      state.lastRaiseWasFull = false;
    }
  }
  seat.actedThisStreet = true;
  const advance = advanceBetting(state);
  const base = pay > 0n ? [paymentObligation(state, playerId, pay, reason)] : [];
  return {
    obligations: obligationsForAdvance(state, base, advance),
    summary: `all_in:${playerId}:${pay}:${describeAdvance(advance)}`,
  };
}

// ---------------------------------------------------------------------------
// Settlement completion
// ---------------------------------------------------------------------------

function distributePots(state: TableState): ApplyOutcome {
  if (state.phase !== "SETTLEMENT") {
    throw new PokerError("WRONG_PHASE", `distribute requires SETTLEMENT, got ${state.phase}`);
  }
  // Recompute the (deterministic) settlement outcome. This must be identical
  // to what enterSettlement produced; the coordinator has already confirmed
  // every payout/refund over Fiber when this action is applied.
  const outcome: SettlementOutcome = deriveSettlement(state);
  for (const award of outcome.awards) {
    state.seats.find((s) => s.playerId === award.playerId)!.stack += award.amount;
  }
  for (const refund of outcome.refunds) {
    state.seats.find((s) => s.playerId === refund.playerId)!.stack += refund.amount;
  }
  const completedHandId = state.handId;
  for (const s of state.seats) {
    s.streetContribution = 0n;
    s.handContribution = 0n;
    s.folded = false;
    s.allIn = false;
    s.actedThisStreet = false;
    s.holeCards = [];
  }
  state.phase = "HAND_COMPLETE";
  state.street = undefined;
  state.actingSeat = undefined;
  state.currentBet = 0n;
  state.minimumRaise = state.config.bigBlind;
  state.lastRaiseWasFull = true;
  state.board = [];
  state.deck = [];
  state.deckCommitment = undefined;
  state.handId = "";
  // Chips moved to stacks: pots/awards are cleared so value is never
  // double-counted (the settlement event already records them).
  state.pots = [];
  state.awards = [];
  return { obligations: [], summary: `hand_complete:${completedHandId}` };
}

function abortHand(state: TableState, reason: string): ApplyOutcome {
  if (state.phase !== "HAND_SETUP" && state.phase !== "POST_SMALL_BLIND" && state.phase !== "POST_BIG_BLIND") {
    throw new PokerError("WRONG_PHASE", `abort only before live betting, phase=${state.phase}`);
  }
  const obligations: EconomicObligation[] = [];
  for (const s of state.seats) {
    if (s.handContribution > 0n) {
      obligations.push({
        kind: "PAY_PLAYER",
        playerId: s.playerId!,
        amount: s.handContribution,
        reason: "REFUND",
        obligationId: `${state.handId}:${state.sequence}:REFUND:${s.playerId}`,
      });
      s.stack += s.handContribution;
      s.handContribution = 0n;
      s.streetContribution = 0n;
    }
  }
  state.phase = "WAITING";
  state.street = undefined;
  state.actingSeat = undefined;
  state.aborted = true;
  state.abortReason = reason;
  state.handId = "";
  state.board = [];
  state.deck = [];
  state.deckCommitment = undefined;
  return { obligations, summary: `hand_aborted:${reason}` };
}

export function engine(): FiberPokerEngine {
  return new FiberPokerEngine();
}

// Re-exports for consumers of the package.
export { createTableState, seatByPlayer, activeSeats, deriveSettlement, settlementObligations };
export { enterSettlement, legalActionsFor, isActingSeat } from "./betting.ts";
export * from "./cards.ts";
export * from "./evaluator.ts";
export * from "./types.ts";
export * from "./state.ts";
export * from "./pots.ts";
