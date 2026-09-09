/**
 * Property/fuzz tests for the poker engine (handoff docs/09 section 2).
 *
 * Drives many random hands with random (legal) action sequences and asserts
 * the engine invariants on every single transition:
 *   - value conservation (stacks + committed chips + pots + awards constant)
 *   - no negative stacks or contributions
 *   - folded players never eligible for pots
 *   - deterministic replay: same seed => identical final state
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  createTableState,
  DEFAULT_CONFIG,
  deriveSettlement,
  fullDeck,
  type Card,
  type PokerAction,
  type Shannon,
  type TableState,
} from "@fiber-poker/poker-engine";
import { E } from "../../packages/poker-engine/test/harness.ts";

const K = 100_000_000n;

/** Deterministic PRNG for property runs (mulberry32). */
function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledDeck(seed: number): Card[] {
  const rng = rngFrom(seed);
  const deck = fullDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

interface SimConfig {
  players: number;
  stacks: bigint[];
  deckSeed: number;
  actionSeed: number;
  maxActions: number;
}

/** Total value in play; invariant across every transition.
 *  streetContribution ⊆ handContribution, and derived pots/awards are a
 *  partition of handContribution at settlement — so neither is summed here. */
function totalValue(state: TableState): bigint {
  return state.seats.reduce((acc, s) => acc + s.stack + s.handContribution, 0n);
}

function checkInvariants(state: TableState, initial: Shannon, path: string): void {
  for (const s of state.seats) {
    expect(s.stack >= 0n, `${path}: negative stack seat ${s.seat}`).toBe(true);
    expect(s.handContribution >= 0n, `${path}: negative contribution seat ${s.seat}`).toBe(true);
    expect(s.stack + s.handContribution <= initial, `${path}: seat ${s.seat} exceeds table value`).toBe(true);
    if (s.playerId === null) {
      expect(s.holeCards.length === 0, `${path}: empty seat with cards`).toBe(true);
    }
  }
  expect(totalValue(state), `${path}: conservation (seq ${state.sequence})`).toBe(initial);
  // Folded players are never eligible.
  for (const pot of state.pots) {
    for (const id of pot.eligiblePlayerIds) {
      const seat = state.seats.find((x) => x.playerId === id)!;
      expect(seat.folded, `${path}: folded player ${id} eligible for pot`).toBe(false);
    }
  }
}

function stateKey(state: TableState): string {
  return JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

/**
 * Drive one hand from WAITING to HAND_COMPLETE using seeded random legal
 * actions. Returns the list of applied actions for replay.
 */
function simulateHand(cfg: SimConfig): { states: TableState[]; actions: PokerAction[] } {
  const rng = rngFrom(cfg.actionSeed);
  const deck = shuffledDeck(cfg.deckSeed);
  let state = createTableState("prop-table", { ...DEFAULT_CONFIG, smallBlind: 1n * K, bigBlind: 2n * K });
  for (let i = 0; i < cfg.players; i++) {
    const r = E.reduce(state, { type: "SIT_DOWN", playerId: `P${i}`, fiberPubkey: `pk${i}`, seat: i, buyIn: cfg.stacks[i]! });
    if (!r.ok) throw new Error(`sit_down failed: ${r.error.code}`);
    state = r.transition.nextState;
  }
  const initial = totalValue(state);
  const start = E.reduce(state, { type: "START_HAND", handId: "prop-hand", deck, deckCommitment: "commit" });
  if (!start.ok) return { states: [state], actions: [] }; // too few eligible players
  state = start.transition.nextState;

  const states: TableState[] = [state];
  const actions: PokerAction[] = [];

  const applyOrThrow = (action: PokerAction, path: string): void => {
    const r = E.reduce(state, action);
    if (!r.ok) throw new Error(`${path}: ${action.type} rejected: ${r.error.code} ${r.error.message}`);
    state = r.transition.nextState;
    actions.push(action);
    states.push(state);
    checkInvariants(state, initial, path);
  };

  // Blinds: payments are simulated as immediate successes.
  for (let step = 0; step < 2 && (state.phase === "POST_SMALL_BLIND" || state.phase === "POST_BIG_BLIND"); step++) {
    const seat = state.seats[state.actingSeat!]!;
    applyOrThrow({ type: "POST_BLIND", playerId: seat.playerId! }, `blind/${step}`);
  }

  for (let step = 0; step < cfg.maxActions && state.phase !== "SETTLEMENT"; step++) {
    if (state.phase !== "PREFLOP" && state.phase !== "FLOP" && state.phase !== "TURN" && state.phase !== "RIVER") break;
    const actingSeat = state.seats[state.actingSeat!]!;
    const playerId = actingSeat.playerId!;
    const legal = E.legalActions(state, playerId)!;
    const pick = legal.actions[Math.floor(rng() * legal.actions.length)]!;
    const path = `action/${step}`;
    switch (pick) {
      case "FOLD":
        applyOrThrow({ type: "FOLD", playerId }, path);
        break;
      case "CHECK":
        applyOrThrow({ type: "CHECK", playerId }, path);
        break;
      case "CALL":
        applyOrThrow({ type: "CALL", playerId }, path);
        break;
      case "ALL_IN":
        applyOrThrow({ type: "ALL_IN", playerId }, path);
        break;
      case "BET":
      case "RAISE": {
        const la = E.legalActions(state, playerId) as Extract<
          ReturnType<typeof E.legalActions>,
          { maxRaiseTo: bigint }
        >;
        // Random raise-to between min and max, biased toward smaller bets.
        const span = la.maxRaiseTo - la.minRaiseTo;
        const frac = rng() ** 2;
        let to = la.minRaiseTo + BigInt(Math.floor(Number(span) * frac));
        if (rng() < 0.3) to = la.minRaiseTo; // min-raise a lot
        applyOrThrow(
          state.currentBet === 0n
            ? { type: "BET", playerId, amount: to }
            : { type: "RAISE", playerId, amount: to },
          path,
        );
        break;
      }
      default:
        throw new Error(`unexpected legal action ${pick}`);
    }
  }

  if (state.phase === "SETTLEMENT") {
    // Settlement invariants: pots sum equals contributions; awards + refunds
    // cover every pot and refund exactly.
    const committed = state.seats.reduce((a, s) => a + s.handContribution, 0n);
    const potted = state.pots.reduce((a, p) => a + p.amount, 0n);
    expect(potted <= committed).toBe(true);
    const outcome = deriveSettlement(state);
    const awardTotal = outcome.awards.reduce((a, x) => a + x.amount, 0n);
    const refundTotal = outcome.refunds.reduce((a, x) => a + x.amount, 0n);
    expect(awardTotal + refundTotal, "awards+refunds == committed").toBe(committed);
    applyOrThrow({ type: "DISTRIBUTE_POTS" }, "settlement");
  }
  return { states, actions };
}

describe("poker engine properties", () => {
  it("conserves value and keeps invariants across random hands (2-6 players)", () => {
    const prop = fc.property(
      fc.integer({ min: 2, max: 6 }),
      fc.integer({ min: 1, max: 2 ** 31 - 1 }),
      fc.integer({ min: 1, max: 2 ** 31 - 1 }),
      (players, deckSeed, actionSeed) => {
        const stacks = Array.from({ length: players }, (_, i) => (20n + BigInt((deckSeed >> i) % 180)) * 2n * K);
        simulateHand({ players, stacks, deckSeed, actionSeed, maxActions: 60 });
      },
    );
    fc.assert(prop, { numRuns: 300, endOnFailure: false });
  });

  it("replays deterministically: same seeds produce identical states", () => {
    const prop = fc.property(
      fc.integer({ min: 2, max: 6 }),
      fc.integer({ min: 1, max: 2 ** 31 - 1 }),
      fc.integer({ min: 1, max: 2 ** 31 - 1 }),
      (players, deckSeed, actionSeed) => {
        const stacks = Array.from({ length: players }, (_, i) => (20n + BigInt((deckSeed >> i) % 180)) * 2n * K);
        const a = simulateHand({ players, stacks, deckSeed, actionSeed, maxActions: 60 });
        const b = simulateHand({ players, stacks, deckSeed, actionSeed, maxActions: 60 });
        expect(stateKey(a.states[a.states.length - 1]!)).toBe(stateKey(b.states[b.states.length - 1]!));
        expect(a.actions.length).toBe(b.actions.length);
      },
    );
    fc.assert(prop, { numRuns: 100 });
  });

  it("never leaves value unconserved after ALL-IN runouts specifically", () => {
    // Force frequent all-in hands: small stacks relative to blinds.
    const prop = fc.property(
      fc.integer({ min: 2, max: 6 }),
      fc.integer({ min: 1, max: 2 ** 31 - 1 }),
      fc.integer({ min: 1, max: 2 ** 31 - 1 }),
      (players, deckSeed, actionSeed) => {
        const stacks = Array.from({ length: players }, (_, i) => (2n + BigInt((deckSeed >> i) % 6)) * 2n * K);
        simulateHand({ players, stacks, deckSeed, actionSeed, maxActions: 60 });
      },
    );
    fc.assert(prop, { numRuns: 200 });
  });
});
