/**
 * Deterministic 7-card hand evaluator.
 *
 * Evaluates all C(7,5)=21 five-card subsets (or C(6,5)=20 / C(5,5)=1 for
 * 5/6-card boards edge cases) and returns a comparable numeric ranking:
 * category * 15^5 + tiebreaker digits, all base-15 to keep ordering exact.
 *
 * Higher value strictly wins; equal values are an exact tie (for splitting).
 */

import { cardRank, cardSuit, type Card } from "./cards.ts";

export const CATEGORY_NAMES = [
  "high_card",
  "pair",
  "two_pair",
  "three_of_a_kind",
  "straight",
  "flush",
  "full_house",
  "four_of_a_kind",
  "straight_flush",
] as const;

export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
} as const;

/** Rank a 5-card hand. Returns category plus ordered tiebreaker ranks (5 slots, 0-padded). */
function rank5(cards: readonly Card[]): HandRank {
  const ranks = cards.map(cardRank).sort((a, b) => b - a);
  const suits = cards.map(cardSuit);
  const isFlush = suits.every((s) => s === suits[0]);

  // Straight detection (incl. wheel A2345 -> high card is the 5).
  let straightHigh = -1;
  {
    const uniq = Array.from(new Set(ranks));
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) {
        straightHigh = uniq[0];
      } else if (uniq[0] === 12 && uniq[1] === 3 && uniq[4] === 0) {
        straightHigh = 3; // wheel
      }
    }
  }

  // Count rank multiplicities.
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));

  let category: number;
  let tb: [number, number, number, number, number];

  if (isFlush && straightHigh >= 0) {
    category = CATEGORY.STRAIGHT_FLUSH;
    tb = [straightHigh, 0, 0, 0, 0];
  } else if (groups[0][1] === 4) {
    category = CATEGORY.FOUR_OF_A_KIND;
    tb = [groups[0][0], groups[1][0], 0, 0, 0];
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    category = CATEGORY.FULL_HOUSE;
    tb = [groups[0][0], groups[1][0], 0, 0, 0];
  } else if (isFlush) {
    category = CATEGORY.FLUSH;
    tb = [ranks[0], ranks[1], ranks[2], ranks[3], ranks[4]];
  } else if (straightHigh >= 0) {
    category = CATEGORY.STRAIGHT;
    tb = [straightHigh, 0, 0, 0, 0];
  } else if (groups[0][1] === 3) {
    category = CATEGORY.THREE_OF_A_KIND;
    tb = [groups[0][0], groups[1][0], groups[2][0], 0, 0];
  } else if (groups[0][1] === 2 && groups[1][1] === 2) {
    category = CATEGORY.TWO_PAIR;
    tb = [groups[0][0], groups[1][0], groups[2][0], 0, 0];
  } else if (groups[0][1] === 2) {
    category = CATEGORY.PAIR;
    tb = [groups[0][0], groups[1][0], groups[2][0], groups[3][0], 0];
  } else {
    category = CATEGORY.HIGH_CARD;
    tb = [ranks[0], ranks[1], ranks[2], ranks[3], ranks[4]];
  }

  let value = category;
  for (const t of tb) value = value * 15 + t;
  return { value, category, tiebreakers: tb };
}

export interface HandRank {
  /** Single comparable integer; higher wins. */
  value: number;
  /** One of CATEGORY.* */
  category: number;
  /** Ordered tiebreaker ranks. */
  tiebreakers: readonly number[];
}

const FIVE_OF_SEVEN: readonly number[][] = (() => {
  const out: number[][] = [];
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let c = b + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++)
          for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
  return out;
})();

/**
 * Evaluate the best 5-card hand from 5, 6, or 7 cards.
 * `cards` must be distinct and drawn from one deck.
 */
export function evaluateHoleAndBoard(cards: readonly Card[]): HandRank {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluateHoleAndBoard expects 5..7 cards, got ${cards.length}`);
  }
  if (cards.length === 5) return rank5(cards);
  let best: HandRank | undefined;
  const subsets = cards.length === 7 ? FIVE_OF_SEVEN : FIVE_OF_SEVEN.filter((idx) => idx.every((i) => i < 6));
  for (const idx of subsets) {
    const r = rank5(idx.map((i) => cards[i]));
    if (best === undefined || r.value > best.value) best = r;
  }
  return best!;
}

/** Compare two hands: 1 left wins, -1 right wins, 0 exact tie. */
export function compareHands(a: HandRank, b: HandRank): 1 | -1 | 0 {
  if (a.value > b.value) return 1;
  if (a.value < b.value) return -1;
  return 0;
}
