/**
 * Deterministic main/side-pot derivation and award computation.
 *
 * Pots are derived level-by-level from every seat's handContribution
 * (folded players' chips stay in pots; folded players are excluded from
 * eligibility). A contribution level above every non-folded player is
 * uncalled and refunded to its contributor instead of entering a pot.
 *
 * Odd chips from split pots go one apiece, round-robin, to tied winners in
 * clockwise order starting from the first seat after the button.
 */

import { evaluateHoleAndBoard } from "./evaluator.ts";
import type { Award, EconomicObligation, PotState, Shannon, TableState } from "./types.ts";

export interface SettlementOutcome {
  pots: PotState[];
  awards: Award[];
  refunds: { playerId: string; amount: Shannon }[];
}

interface Band {
  /** Exclusive lower contribution level. */
  from: bigint;
  /** Inclusive upper contribution level. */
  to: bigint;
  contributors: string[];
  eligible: string[];
}

export function deriveSettlement(state: TableState): SettlementOutcome {
  const inHand = state.seats.filter((s) => s.playerId !== null && s.handContribution > 0n);
  const levels = Array.from(
    new Set(inHand.map((s) => s.handContribution)),
  ).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const bands: Band[] = [];
  const refunds: { playerId: string; amount: Shannon }[] = [];
  let prev = 0n;
  for (const level of levels) {
    const contributors = inHand.filter((s) => s.handContribution >= level).map((s) => s.playerId!);
    const eligible = contributors.filter((id) => !inHand.find((s) => s.playerId === id)!.folded);
    const amount = (level - prev) * BigInt(contributors.length);
    if (eligible.length === 0) {
      // No live player reached this level: the chips are uncalled. Refund
      // equally to the (in practice exactly one) contributors there.
      refunds.push(...refundEqually(state, contributors, amount));
    } else if (contributors.length === 1) {
      // A band only one player contributed to is uncalled excess above
      // every opponent, even when that player is still live. Refund it.
      refunds.push({ playerId: contributors[0]!, amount });
    } else {
      bands.push({ from: prev, to: level, contributors, eligible });
    }
    prev = level;
  }

  // Merge adjacent bands with identical eligibility into single pots.
  const pots: PotState[] = [];
  let potId = 0;
  for (const band of bands) {
    const amount = (band.to - band.from) * BigInt(band.contributors.length);
    const last = pots[pots.length - 1];
    if (last && sameEligibility(last.eligiblePlayerIds, band.eligible)) {
      last.amount += amount;
    } else {
      pots.push({ potId: potId++, amount, eligiblePlayerIds: [...band.eligible] });
    }
  }

  // Evaluate hands once per showdown participant with a stake in a
  // contested (2+ eligible) pot. Uncontested pots go to their lone
  // eligible player without evaluation, so fold-wins never need a board.
  const contested = pots.filter((p) => p.eligiblePlayerIds.length >= 2);
  const handValues = new Map<string, number>();
  if (contested.length > 0) {
    for (const s of state.seats) {
      if (s.playerId === null || s.folded || s.holeCards.length === 0) continue;
      if (!contested.some((p) => p.eligiblePlayerIds.includes(s.playerId!))) continue;
      handValues.set(s.playerId, evaluateHoleAndBoard([...s.holeCards, ...state.board]).value);
    }
  }

  // Seat order clockwise from the button, used for odd-chip distribution.
  const buttonSeat = state.buttonSeat ?? -1;
  const nSeats = state.seats.length;
  const clockwiseFromButton = (ids: string[]): string[] => {
    const seatOf = (id: string) => state.seats.find((s) => s.playerId === id)!.seat;
    return [...ids].sort((a, b) => {
      const da = (seatOf(a) - buttonSeat + nSeats) % nSeats;
      const db = (seatOf(b) - buttonSeat + nSeats) % nSeats;
      return da - db || seatOf(a) - seatOf(b);
    });
  };

  const awards: Award[] = [];
  const award = (playerId: string, amount: Shannon, potId: number): void => {
    const existing = awards.find((a) => a.playerId === playerId);
    if (existing) {
      existing.amount += amount;
      existing.potIds.push(potId);
    } else {
      awards.push({ playerId, amount, potIds: [potId], oddChips: 0n });
    }
  };

  for (const pot of pots) {
    if (pot.eligiblePlayerIds.length === 1) {
      award(pot.eligiblePlayerIds[0]!, pot.amount, pot.potId);
      continue;
    }
    let best = -Infinity;
    for (const id of pot.eligiblePlayerIds) best = Math.max(best, handValues.get(id)!);
    const winners = clockwiseFromButton(pot.eligiblePlayerIds.filter((id) => handValues.get(id) === best));
    const n = BigInt(winners.length);
    const share = pot.amount / n;
    const remainder = Number(pot.amount % n);
    const perWinner = new Map<string, Shannon>(winners.map((w) => [w, share]));
    for (let i = 0; i < remainder; i++) {
      const w = winners[i % winners.length];
      perWinner.set(w, perWinner.get(w)! + 1n);
    }
    for (const [playerId, amount] of perWinner) {
      const oddChips = amount - share;
      const existing = awards.find((a) => a.playerId === playerId);
      if (existing) {
        existing.amount += amount;
        existing.potIds.push(pot.potId);
        existing.oddChips += oddChips;
      } else {
        awards.push({ playerId, amount, potIds: [pot.potId], oddChips });
      }
    }
  }

  return { pots, awards, refunds };
}

function refundEqually(
  state: TableState,
  contributorIds: string[],
  amount: Shannon,
): { playerId: string; amount: Shannon }[] {
  // Every contributor at a band paid the same (level - prev) into it, so the
  // refund splits equally; the shannon remainder goes in ascending seat order.
  const seats = state.seats
    .filter((s) => s.playerId !== null && contributorIds.includes(s.playerId))
    .sort((a, b) => a.seat - b.seat);
  const out = seats.map((s) => ({ playerId: s.playerId!, amount: amount / BigInt(seats.length) }));
  let distributed = out.reduce((acc, r) => acc + r.amount, 0n);
  let idx = 0;
  while (distributed < amount) {
    out[idx % out.length]!.amount += 1n;
    distributed += 1n;
    idx++;
  }
  return out.filter((r) => r.amount > 0n);
}

function sameEligibility(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/** Build payout obligations from a settlement outcome (deterministic ids). */
export function settlementObligations(
  handId: string,
  sequence: bigint,
  outcome: SettlementOutcome,
): EconomicObligation[] {
  const obligations: EconomicObligation[] = [];
  for (const award of outcome.awards) {
    obligations.push({
      kind: "PAY_PLAYER",
      playerId: award.playerId,
      amount: award.amount,
      reason: "PAYOUT",
      obligationId: `${handId}:${sequence}:PAYOUT:${award.playerId}`,
    });
  }
  for (const refund of outcome.refunds) {
    obligations.push({
      kind: "PAY_PLAYER",
      playerId: refund.playerId,
      amount: refund.amount,
      reason: "REFUND",
      obligationId: `${handId}:${sequence}:REFUND:${refund.playerId}`,
    });
  }
  return obligations;
}
