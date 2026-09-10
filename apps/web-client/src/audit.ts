/**
 * Deck audit (docs/08): after the server reveals the permutation + nonce,
 * verify the commitment and that the dealt cards match the revealed deck.
 *
 * CAVEAT (also shown in the UI): this proves the deck did not change after
 * commitment. It does NOT prove the server chose an unfavorable-before-commit
 * shuffle; the server sees all cards in V0.
 */

import { combinedSeedFor, seedCommitment, shuffleFromSeed, deckFromReveal, computeCommitment, verifyReveal, type DeckReveal } from "@fiber-poker/deck";
import { holeCardsHash } from "@fiber-poker/protocol";
import { cardToString, cardFromString } from "@fiber-poker/poker-engine";
import type { PublicTableState } from "@fiber-poker/protocol";

export interface AuditResult {
  commitmentOk: boolean;
  dealingOk: boolean | null; // null when we cannot fully verify (insufficient info)
  seedOk: boolean | null; // P10: multiparty seed derivation verified
  detail: string;
}

/**
 * Reconstruct the deal from the revealed permutation and the hand-start
 * public state, then check every seat's hole-card commitment and the board.
 */
export function auditReveal(reveal: DeckReveal, handStart: PublicTableState, finalBoard: number[]): AuditResult {
  const commitmentOk = verifyReveal(reveal) && computeCommitment(reveal.handId, reveal.permutation, reveal.nonce) === reveal.commitment;

  // P10: when the reveal carries multiparty seeds, re-derive everything.
  let seedOk: boolean | null = null;
  const seeds = (reveal as { seeds?: { playerId: string; seed: string }[] }).seeds;
  if (seeds && Array.isArray(seeds) && seeds.length > 0) {
    try {
      // 1. every seed matches its commitment? (commitments are not in the
      // reveal payload; instead verify the permutation derives from the
      // combined seed — commitments were broadcast pre-hand and logged)
      const combined = combinedSeedFor(
        reveal.handId,
        seeds.map((s) => ({ playerId: s.playerId, seed: Uint8Array.from(s.seed.match(/.{2}/g)!.map((h) => Number.parseInt(h, 16))) })),
      );
      const derivedPermutation = shuffleFromSeed(combined);
      seedOk = derivedPermutation.join(",") === reveal.permutation.join(",");
    } catch {
      seedOk = false;
    }
  }

  if (!commitmentOk) {
    return { commitmentOk: false, dealingOk: null, seedOk, detail: "commitment mismatch — deck reveal does not hash to the committed value" };
  }

  try {
    const deck = deckFromReveal(reveal);
    // Dealt-in seats at hand start: clockwise from the small blind.
    const n = handStart.seats.length;
    const sb = handStart.smallBlindSeat ?? 0;
    const dealtIn: number[] = [];
    for (let i = 0; i < n; i++) {
      const seat = handStart.seats[(sb + i) % n]!;
      if (seat.playerId !== null) dealtIn.push(seat.seat);
    }
    let pos = 0;
    const seatCards = new Map<number, number[]>();
    for (let round = 0; round < 2; round++) {
      for (const seat of dealtIn) {
        const cards = seatCards.get(seat) ?? [];
        cards.push(deck[pos++]!);
        seatCards.set(seat, cards);
      }
    }
    const board = deck.slice(pos, pos + 5);

    // Verify every seat commitment from the final public state.
    for (const s of handStart.seats) {
      if (!s.playerId || !s.holeCardsHash) continue;
      const cards = seatCards.get(s.seat) ?? [];
      const computed = holeCardsHash(reveal.handId, cards);
      if (computed !== s.holeCardsHash) {
        return { commitmentOk: true, dealingOk: false, seedOk, detail: `seat ${s.seat} hole cards do not match the revealed deck` };
      }
    }
    // Verify the observed board.
    const boardStr = board.map(cardToString).join(",");
    const observedStr = finalBoard.map((c) => cardToString(cardFromString(String(c)))).join(",");
    if (boardStr !== observedStr) {
      return { commitmentOk: true, dealingOk: false, seedOk, detail: `board mismatch: revealed deck gives [${boardStr}] but table showed [${observedStr}]` };
    }
    const seedNote = seedOk === null ? "" : seedOk ? " · seed derivation verified" : " · SEED DERIVATION MISMATCH";
    return { commitmentOk: true, dealingOk: true, seedOk, detail: `commitment + dealing verified (${dealtIn.length} players, board [${boardStr}])${seedNote}` };
  } catch (e) {
    return { commitmentOk: true, dealingOk: null, seedOk, detail: `partial audit: ${String(e)}` };
  }
}

export type { DeckReveal };
