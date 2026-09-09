/**
 * Shared test harness for engine tests: deterministic decks, quick table
 * setup, action helpers. Pure — no randomness anywhere.
 */

import {
  cardFromString,
  createTableState,
  DEFAULT_CONFIG,
  engine,
  fullDeck,
  type Card,
  type PokerAction,
  type Shannon,
  type TableState,
} from "../src/index.ts";

export const E = engine();

const K = 100_000_000n; // 1 CKB in shannons

export function makeTable(n: number, opts?: { sb?: bigint; bb?: bigint }): TableState {
  const cfg = { ...DEFAULT_CONFIG, maxSeats: 6 };
  cfg.smallBlind = opts?.sb ?? 1n * K;
  cfg.bigBlind = opts?.bb ?? 2n * K;
  return createTableState("table-test", cfg);
}

export function apply(state: TableState, action: PokerAction): TableState {
  const r = E.reduce(state, action);
  if (!r.ok) {
    throw new Error(`action ${action.type} by ${(action as { playerId?: string }).playerId} failed: ${r.error.code} ${r.error.message}`);
  }
  return r.transition.nextState;
}

export function tryApply(state: TableState, action: PokerAction) {
  return E.reduce(state, action);
}

/** Seat `n` players (P0..Pn-1) with equal stacks in seats 0..n-1. */
export function seatPlayers(state: TableState, stacks: bigint[]): TableState {
  let s = state;
  stacks.forEach((stack, i) => {
    s = apply(s, { type: "SIT_DOWN", playerId: `P${i}`, fiberPubkey: `pk${i}`, seat: i, buyIn: stack });
  });
  return s;
}

/** Deterministic deck built to deal specific hole cards and board. */
export function buildDeck(
  dealOrder: number[],
  holes: Record<number, [string, string]>,
  board: string[],
): Card[] {
  const used = new Set<number>();
  const deck: Card[] = [];
  for (let round = 0; round < 2; round++) {
    for (const seat of dealOrder) {
      const cs = holes[seat]!;
      const c = cardFromString(cs[round]!);
      if (used.has(c)) throw new Error(`card ${cs[round]} used twice`);
      used.add(c);
      deck.push(c);
    }
  }
  for (const cs of board) {
    const c = cardFromString(cs);
    if (used.has(c)) throw new Error(`card ${cs} used twice`);
    used.add(c);
    deck.push(c);
  }
  for (const c of fullDeck()) {
    if (!used.has(c)) deck.push(c);
  }
  return deck;
}

/** Start a hand with a prepared deck; returns POST_SMALL_BLIND state. */
export function startHand(
  state: TableState,
  deck: Card[],
  handId = `hand-${state.handNo + 1}`,
): TableState {
  return apply(state, { type: "START_HAND", handId, deck, deckCommitment: `commit-${handId}` });
}

/** Post both blinds with successful-payment semantics. */
export function postBlinds(state: TableState): TableState {
  const sb = apply(state, { type: "POST_BLIND", playerId: state.seats[state.smallBlindSeat!]!.playerId! });
  return apply(sb, { type: "POST_BLIND", playerId: sb.seats[sb.bigBlindSeat!]!.playerId! });
}

/** Convenience: seat, start hand, post blinds; returns PREFLOP state. */
export function readyHand(stacks: bigint[], deck?: Card[]): TableState {
  let s = seatPlayers(makeTable(stacks.length), stacks);
  s = startHand(s, deck ?? fullDeck());
  s = postBlinds(s);
  return s;
}

/** The player id acting in the current state. */
export function actor(state: TableState): string {
  return state.seats[state.actingSeat!]!.playerId!;
}

/** Serialize a state for determinism comparison (bigint-safe). */
export function stateKey(state: TableState): string {
  return JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

export function assertConserved(state: TableState, initial: Shannon): void {
  const inPot =
    state.seats.reduce((acc, s) => acc + s.handContribution, 0n) +
    state.pots.reduce((acc, p) => acc + p.amount, 0n) +
    state.awards.reduce((acc, a) => acc + a.amount, 0n);
  const total = state.seats.reduce((acc, s) => acc + s.stack, 0n) + inPot;
  if (total !== initial) {
    throw new Error(`conservation violated: ${total} != ${initial}`);
  }
}
