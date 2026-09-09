import { describe, expect, it } from "vitest";

import { deriveSettlement, fullDeck, legalActionsFor } from "../src/index.ts";
import {
  actor,
  apply,
  assertConserved,
  buildDeck,
  E,
  makeTable,
  postBlinds,
  readyHand,
  seatPlayers,
  startHand,
  stateKey,
  tryApply,
} from "./harness.ts";

const K = 100_000_000n; // 1 CKB in shannons
const SB = 1n * K; // small blind
const BB = 2n * K; // big blind

function initialTotal(state: { seats: { stack: bigint; handContribution: bigint }[] }): bigint {
  return state.seats.reduce((a, s) => a + s.stack + s.handContribution, 0n);
}

describe("table setup and blinds", () => {
  it("seats 2..6 players and assigns button/blinds for 3+ players", () => {
    for (const n of [3, 4, 5, 6]) {
      const s = seatPlayers(makeTable(n), Array(n).fill(100n * K));
      const started = E.reduce(s, {
        type: "START_HAND",
        handId: "h1",
        deck: fullDeck(),
        deckCommitment: "c1",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) continue;
      const post = started.transition.nextState;
      expect(post.buttonSeat).toBe(0); // first hand: lowest eligible seat
      expect(post.smallBlindSeat).toBe(1);
      expect(post.bigBlindSeat).toBe(2);
      expect(started.transition.obligations).toHaveLength(1);
      expect(started.transition.obligations[0]!.reason).toBe("SMALL_BLIND");
      expect(started.transition.obligations[0]!.amount).toBe(SB);
      // Posting the SB returns the BB obligation.
      const sbPosted = E.reduce(post, { type: "POST_BLIND", playerId: post.seats[1]!.playerId! });
      expect(sbPosted.ok).toBe(true);
      if (sbPosted.ok) {
        expect(sbPosted.transition.obligations).toHaveLength(1);
        expect(sbPosted.transition.obligations[0]!.reason).toBe("BIG_BLIND");
        expect(sbPosted.transition.obligations[0]!.amount).toBe(BB);
      }
    }
  });

  it("posts blinds, deals hole cards, and opens preflop with UTG", () => {
    const s = readyHand([100n * K, 100n * K, 100n * K]);
    expect(s.phase).toBe("PREFLOP");
    expect(s.street).toBe("PREFLOP");
    expect(s.currentBet).toBe(BB);
    expect(s.actingSeat).toBe(0); // first to act preflop is after the BB
    for (const seat of s.seats) {
      if (seat.playerId === null) continue;
      expect(seat.holeCards).toHaveLength(2);
      expect(seat.stack).toBe(100n * K - (seat.seat === 1 ? SB : seat.seat === 2 ? BB : 0n));
    }
    expect(s.seats[0]!.holeCards.length + s.seats[1]!.holeCards.length).toBe(4);
    expect(s.deck).toHaveLength(52 - 6);
  });

  it("rotates the button clockwise between hands", () => {
    let s = readyHand([100n * K, 100n * K, 100n * K]);
    s = apply(s, { type: "FOLD", playerId: actor(s) });
    s = apply(s, { type: "FOLD", playerId: actor(s) });
    expect(s.phase).toBe("SETTLEMENT");
    s = apply(s, { type: "DISTRIBUTE_POTS" });
    expect(s.phase).toBe("HAND_COMPLETE");
    s = startHand(s, fullDeck());
    expect(s.buttonSeat).toBe(1);
    expect(s.smallBlindSeat).toBe(2);
    expect(s.bigBlindSeat).toBe(0);
  });

  it("handles heads-up blinds: button posts SB and acts first preflop", () => {
    const s = readyHand([100n * K, 100n * K]);
    expect(s.buttonSeat).toBe(0);
    expect(s.smallBlindSeat).toBe(0);
    expect(s.bigBlindSeat).toBe(1);
    expect(s.actingSeat).toBe(0); // button/SB acts first preflop
  });

  it("heads-up: BB acts first postflop", () => {
    const s = readyHand([100n * K, 100n * K]);
    const s1 = apply(s, { type: "CALL", playerId: "P0" });
    expect(s1.actingSeat).toBe(1); // BB still holds the preflop option
    const s2 = apply(s1, { type: "CHECK", playerId: "P1" });
    expect(s2.street).toBe("FLOP");
    expect(s2.actingSeat).toBe(1); // BB first postflop
  });

  it("gives the BB the check option when everyone limps (3+ players)", () => {
    const s = readyHand([100n * K, 100n * K, 100n * K]);
    const s1 = apply(s, { type: "CALL", playerId: "P0" });
    const s2 = apply(s1, { type: "CALL", playerId: "P1" });
    expect(s2.street).toBe("PREFLOP"); // not advanced yet
    expect(s2.actingSeat).toBe(2); // BB option
    const s3 = apply(s2, { type: "CHECK", playerId: "P2" });
    expect(s3.street).toBe("FLOP");
  });

  it("rejects blind posting from the wrong seat and mid-hand seat changes", () => {
    let s = seatPlayers(makeTable(3), [100n * K, 100n * K, 100n * K]);
    s = startHand(s, fullDeck());
    const wrong = tryApply(s, { type: "POST_BLIND", playerId: s.seats[2]!.playerId! });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe("WRONG_BLIND_SEAT");
    const sitOut = tryApply(s, { type: "SIT_OUT", playerId: "P0" });
    expect(sitOut.ok).toBe(false);
    if (!sitOut.ok) expect(sitOut.error.code).toBe("WRONG_PHASE");
  });
});

describe("betting rules", () => {
  it("enforces minimum raise increments and full-raise reopen", () => {
    const s = readyHand([100n * K, 100n * K, 100n * K]);
    const s1 = apply(s, { type: "CALL", playerId: "P0" });
    const s2 = apply(s1, { type: "RAISE", playerId: "P1", amount: 4n * K });
    expect(s2.currentBet).toBe(4n * K);
    expect(s2.minimumRaise).toBe(2n * K);
    const bad = tryApply(s2, { type: "RAISE", playerId: "P2", amount: 5n * K });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("AMOUNT_TOO_SMALL");
    // A full raise to 6CKB reopens action for P0.
    const s3 = apply(s2, { type: "RAISE", playerId: "P2", amount: 6n * K });
    expect(s3.actingSeat).toBe(0);
    expect(s3.minimumRaise).toBe(2n * K);
    expect(E.legalActions(s3, "P0")!.actions).toContain("RAISE");
  });

  it("short all-in preflop: not-yet-acted may raise, acted seats may not", () => {
    // 3 players: button P0 (UTG), SB P1 (stack 3CKB), BB P2.
    let s = seatPlayers(makeTable(3), [100n * K, 3n * K, 100n * K]);
    s = startHand(s, fullDeck());
    s = postBlinds(s);
    s = apply(s, { type: "CALL", playerId: "P0" }); // P0 acted
    // SB P1 short all-in to 3CKB: increment 1CKB < minRaise 2CKB.
    const s1 = apply(s, { type: "ALL_IN", playerId: "P1" });
    expect(s1.currentBet).toBe(3n * K);
    expect(s1.lastRaiseWasFull).toBe(false);
    // P2 (BB holding the preflop option => not yet acted) MAY raise;
    // P0 (already acted) may not raise again, only call or fold.
    const bbLegal = legalActionsFor(s1, "P2");
    expect(bbLegal.actions).toContain("CALL");
    expect(bbLegal.actions).toContain("RAISE");
    const p0Legal = legalActionsFor(s1, "P0");
    expect(p0Legal.actions).not.toContain("RAISE");
    expect(p0Legal.actions).toContain("CALL");
  });

  it("short all-in postflop does not reopen betting for players who acted", () => {
    // P2 stack 13.5CKB: after the 2CKB blind he has 11.5CKB. All-in over the
    // 10CKB bet is an increment of 1.5CKB < minRaise 2CKB => short raise.
    let s = seatPlayers(makeTable(3), [100n * K, 100n * K, 13n * K + (500_000_000n)]);
    s = startHand(s, fullDeck());
    s = postBlinds(s);
    s = apply(s, { type: "CALL", playerId: "P0" });
    s = apply(s, { type: "CALL", playerId: "P1" });
    s = apply(s, { type: "CHECK", playerId: "P2" });
    expect(s.street).toBe("FLOP");
    s = apply(s, { type: "BET", playerId: "P1", amount: 10n * K });
    const s3 = apply(s, { type: "ALL_IN", playerId: "P2" });
    expect(s3.currentBet).toBe(11n * K + 500_000_000n);
    expect(s3.lastRaiseWasFull).toBe(false);
    // P1 (the original bettor) may not re-raise the short all-in, but P0
    // has not acted on this street yet, so he may still raise.
    const p1Legal = legalActionsFor(s3, "P1");
    expect(p1Legal.actions).not.toContain("RAISE");
    const p0Legal = legalActionsFor(s3, "P0");
    expect(p0Legal.actions).toContain("RAISE");
    // But P1 can still call the extra 1.5CKB.
    expect(p1Legal.actions).toContain("CALL");
  });

  it("not-yet-acted players may still raise over a short all-in blind", () => {
    const s = seatPlayers(makeTable(3), [100n * K, 100n * K, 1n * K + 50_000_000n]); // BB all-in 1.5CKB
    const s1 = startHand(s, fullDeck());
    const s2 = apply(s1, { type: "POST_BLIND", playerId: "P1" }); // SB 1CKB
    const s3 = apply(s2, { type: "POST_BLIND", playerId: "P2" }); // BB all-in 1.5CKB
    expect(s3.seats[2]!.allIn).toBe(true);
    expect(s3.currentBet).toBe(BB); // the full BB is still the bet to call
    const p0Legal = E.legalActions(s3, "P0")!;
    expect(p0Legal.actions).toContain("RAISE");
  });

  it("rejects checks facing a bet and out-of-turn actions", () => {
    const s = readyHand([100n * K, 100n * K, 100n * K]);
    const check = tryApply(s, { type: "CHECK", playerId: "P0" });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error.code).toBe("ILLEGAL_CHECK");
    const oot = tryApply(s, { type: "FOLD", playerId: "P1" });
    expect(oot.ok).toBe(false);
    if (!oot.ok) expect(oot.error.code).toBe("OUT_OF_TURN");
  });

  it("caps wagers at the stack and treats exact-stack as all-in", () => {
    let s = seatPlayers(makeTable(3), [5n * K, 100n * K, 100n * K]);
    s = startHand(s, fullDeck());
    s = postBlinds(s);
    const tooBig = tryApply(s, { type: "RAISE", playerId: "P0", amount: 6n * K });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error.code).toBe("AMOUNT_TOO_LARGE");
    const s1 = apply(s, { type: "RAISE", playerId: "P0", amount: 5n * K });
    expect(s1.seats[0]!.allIn).toBe(true);
    expect(s1.seats[0]!.stack).toBe(0n);
  });
});

describe("fold paths and uncalled bets", () => {
  it("everyone folds to the BB: BB wins the blinds", () => {
    const s0 = readyHand([100n * K, 100n * K, 100n * K]);
    const t0 = initialTotal(s0);
    let s = apply(s0, { type: "FOLD", playerId: "P0" });
    s = apply(s, { type: "FOLD", playerId: "P1" });
    expect(s.phase).toBe("SETTLEMENT");
    // P1's SB is live money in the pot; the BB's unmatched 1CKB refunds.
    expect(s.pots).toHaveLength(1);
    expect(s.pots[0]!.amount).toBe(SB + SB);
    expect(s.awards).toEqual([{ playerId: "P2", amount: SB + SB, potIds: [0], oddChips: 0n }]);
    expect(deriveSettlement(s).refunds).toEqual([{ playerId: "P2", amount: BB - SB }]);
    s = apply(s, { type: "DISTRIBUTE_POTS" });
    expect(s.seats[2]!.stack).toBe(100n * K + SB);
    expect(s.phase).toBe("HAND_COMPLETE");
    assertConserved(s, t0);
  });

  it("returns an uncalled bet when everyone folds to an aggressor", () => {
    const s0 = readyHand([100n * K, 100n * K, 100n * K]);
    const t0 = initialTotal(s0);
    let s = apply(s0, { type: "RAISE", playerId: "P0", amount: 50n * K });
    s = apply(s, { type: "FOLD", playerId: "P1" });
    s = apply(s, { type: "FOLD", playerId: "P2" });
    expect(s.phase).toBe("SETTLEMENT");
    s = apply(s, { type: "DISTRIBUTE_POTS" });
    // P0 nets exactly the blinds; the 48CKB uncalled excess came back.
    expect(s.seats[0]!.stack).toBe(100n * K + SB + BB);
    assertConserved(s, t0);
  });
});

describe("all-in ladders, side pots, and showdowns", () => {
  it("builds deterministic side pots from an all-in ladder and awards by hand strength", () => {
    // 4 players: button P0, SB P1, BB P2, UTG P3. Deal order: [1,2,3,0].
    const deck = buildDeck(
      [1, 2, 3, 0],
      {
        0: ["Ah", "Ad"], // P0: aces -> wins the main pot
        1: ["Qh", "Qd"],
        2: ["Kh", "Kd"], // P2: kings -> win both side pots
        3: ["2c", "3c"],
      },
      ["7c", "8d", "9h", "4d", "5s"], // no flush/straight for P3's trash
    );
    let s = seatPlayers(makeTable(4), [100n * K, 200n * K, 300n * K, 400n * K]);
    const t0 = initialTotal(s);
    s = startHand(s, deck);
    s = postBlinds(s);
    // Shoves in action order: P3(UTG)=400, P0=100, P1=200, P2=300.
    s = apply(s, { type: "ALL_IN", playerId: "P3" });
    s = apply(s, { type: "ALL_IN", playerId: "P0" });
    s = apply(s, { type: "ALL_IN", playerId: "P1" });
    s = apply(s, { type: "ALL_IN", playerId: "P2" });
    expect(s.phase).toBe("SETTLEMENT");
    expect(s.street).toBe("SHOWDOWN");
    expect(s.pots.map((p) => p.amount)).toEqual([400n * K, 300n * K, 200n * K]);
    expect(new Set(s.pots[0]!.eligiblePlayerIds)).toEqual(new Set(["P0", "P1", "P2", "P3"]));
    expect(new Set(s.pots[1]!.eligiblePlayerIds)).toEqual(new Set(["P1", "P2", "P3"]));
    expect(new Set(s.pots[2]!.eligiblePlayerIds)).toEqual(new Set(["P2", "P3"]));
    const awardFor = (id: string) => s.awards.find((a) => a.playerId === id)!.amount;
    expect(awardFor("P0")).toBe(400n * K); // aces take the main pot
    expect(awardFor("P2")).toBe(500n * K); // queens take both side pots
    expect(s.awards.find((a) => a.playerId === "P1")).toBeUndefined();
    expect(s.awards.find((a) => a.playerId === "P3")).toBeUndefined();
    // P3's 100CKB above the second-highest stack is uncalled -> refund.
    expect(deriveSettlement(s).refunds).toEqual([{ playerId: "P3", amount: 100n * K }]);
    s = apply(s, { type: "DISTRIBUTE_POTS" });
    assertConserved(s, t0);
    expect(s.seats[0]!.stack).toBe(400n * K);
    expect(s.seats[2]!.stack).toBe(500n * K);
    expect(s.seats[3]!.stack).toBe(100n * K);
  });

  it("runs the board out automatically when everyone is all-in", () => {
    const deck = buildDeck([1, 2, 0], { 0: ["Ah", "Ad"], 1: ["Kh", "Kd"], 2: ["2c", "3c"] }, [
      "7c",
      "8d",
      "9h",
      "4d",
      "5s",
    ]);
    let s = seatPlayers(makeTable(3), [100n * K, 100n * K, 100n * K]);
    const t0 = initialTotal(s);
    s = startHand(s, deck);
    s = postBlinds(s);
    s = apply(s, { type: "ALL_IN", playerId: "P0" });
    s = apply(s, { type: "ALL_IN", playerId: "P1" });
    s = apply(s, { type: "ALL_IN", playerId: "P2" });
    expect(s.phase).toBe("SETTLEMENT");
    expect(s.board).toHaveLength(5);
    expect(s.awards).toEqual([{ playerId: "P0", amount: 300n * K, potIds: [0], oddChips: 0n }]);
    s = apply(s, { type: "DISTRIBUTE_POTS" });
    assertConserved(s, t0);
  });

  it("splits an odd pot exactly: odd chip clockwise from the button", () => {
    // 3 players. P1 makes an odd dead bet (1 shannon above an even amount)
    // and later folds; P0 and P2 then contribute equally and tie on the
    // board. The odd pot must split 1 extra shannon to the first tied
    // winner clockwise from the button (P0).
    const deck = buildDeck([1, 2, 0], { 0: ["2c", "3c"], 1: ["7h", "8d"], 2: ["2d", "3d"] }, [
      "Ah",
      "Ad",
      "Ac",
      "Kd",
      "Ks",
    ]);
    const ODD_BET = 2n * K + 1n; // flop bet: minimum 2CKB plus one shannon
    let s = seatPlayers(makeTable(3), [100n * K, 100n * K, 100n * K]);
    const t0 = initialTotal(s);
    s = startHand(s, deck);
    s = postBlinds(s);
    s = apply(s, { type: "CALL", playerId: "P0" }); // 2CKB
    s = apply(s, { type: "CALL", playerId: "P1" }); // completes to 2CKB
    s = apply(s, { type: "CHECK", playerId: "P2" });
    expect(s.street).toBe("FLOP");
    s = apply(s, { type: "BET", playerId: "P1", amount: ODD_BET });
    s = apply(s, { type: "CALL", playerId: "P2", }); // P2 matches the odd bet
    s = apply(s, { type: "RAISE", playerId: "P0", amount: 50n * K });
    s = apply(s, { type: "FOLD", playerId: "P1" }); // dead money: 2CKB + ODD_BET
    s = apply(s, { type: "CALL", playerId: "P2" }); // P2 matches 50CKB street
    expect(s.street).toBe("TURN");
    s = apply(s, { type: "CHECK", playerId: "P2" });
    s = apply(s, { type: "CHECK", playerId: "P0" });
    s = apply(s, { type: "CHECK", playerId: "P2" });
    s = apply(s, { type: "BET", playerId: "P0", amount: 20n * K });
    s = apply(s, { type: "CALL", playerId: "P2" });
    expect(s.phase).toBe("SETTLEMENT");
    // Contributions: P0 = P2 = 72CKB; P1 = 2CKB + ODD_BET (odd, all dead).
    const pot = s.pots.reduce((a, p) => a + p.amount, 0n);
    expect(pot).toBe(148n * K + 1n); // odd number of shannons
    expect(s.pots).toHaveLength(1); // dead money joined the top pot
    expect(new Set(s.pots[0]!.eligiblePlayerIds)).toEqual(new Set(["P0", "P2"]));
    const p0Award = s.awards.find((a) => a.playerId === "P0")!.amount;
    const p2Award = s.awards.find((a) => a.playerId === "P2")!.amount;
    expect(p0Award).toBe(74n * K + 1n); // odd chip to P0 (clockwise from button)
    expect(p2Award).toBe(74n * K);
    s = apply(s, { type: "DISTRIBUTE_POTS" });
    assertConserved(s, t0);
  });

  it("excludes folded players from pot eligibility", () => {
    const deck = buildDeck([1, 2, 0], { 0: ["Ah", "Ad"], 1: ["2c", "3c"], 2: ["7h", "8d"] }, [
      "Kc",
      "Qd",
      "Js",
      "4d",
      "5s",
    ]);
    let s = seatPlayers(makeTable(3), [100n * K, 100n * K, 100n * K]);
    const t0 = initialTotal(s);
    s = startHand(s, deck);
    s = postBlinds(s);
    s = apply(s, { type: "CALL", playerId: "P0" });
    s = apply(s, { type: "RAISE", playerId: "P1", amount: 20n * K });
    s = apply(s, { type: "CALL", playerId: "P2" });
    s = apply(s, { type: "CALL", playerId: "P0" });
    expect(s.street).toBe("FLOP");
    // Flop (P1 first): P1 checks, then P2 folds after 20CKB in.
    s = apply(s, { type: "CHECK", playerId: "P1" });
    s = apply(s, { type: "FOLD", playerId: "P2" });
    s = apply(s, { type: "CHECK", playerId: "P0" });
    s = apply(s, { type: "CHECK", playerId: "P1" });
    s = apply(s, { type: "CHECK", playerId: "P0" });
    s = apply(s, { type: "CHECK", playerId: "P1" });
    s = apply(s, { type: "CHECK", playerId: "P0" });
    expect(s.phase).toBe("SETTLEMENT");
    expect(s.pots).toHaveLength(1);
    expect(s.pots[0]!.amount).toBe(60n * K);
    expect(new Set(s.pots[0]!.eligiblePlayerIds)).toEqual(new Set(["P0", "P1"]));
    expect(s.awards).toHaveLength(1);
    expect(s.awards[0]!.playerId).toBe("P0"); // aces hold
    s = apply(s, { type: "DISTRIBUTE_POTS" });
    assertConserved(s, t0);
  });
});

describe("timeout policy actions", () => {
  it("TIMEOUT_CHECK succeeds only when checking is legal", () => {
    const s = readyHand([100n * K, 100n * K]);
    const bad = tryApply(s, { type: "TIMEOUT_CHECK", playerId: "P0" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("ILLEGAL_CHECK");
    const s1 = apply(s, { type: "CALL", playerId: "P0" });
    const s2 = apply(s1, { type: "CHECK", playerId: "P1" });
    expect(s2.street).toBe("FLOP");
    const r3 = E.reduce(s2, { type: "TIMEOUT_CHECK", playerId: "P1" });
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.transition.summary).toContain("timeout_check");
  });

  it("TIMEOUT_FOLD folds the acting seat", () => {
    const s = readyHand([100n * K, 100n * K]);
    const r = E.reduce(s, { type: "TIMEOUT_FOLD", playerId: "P0" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transition.nextState.phase).toBe("SETTLEMENT");
    expect(r.transition.summary).toContain("timeout_fold");
  });
});

describe("hand abort and determinism", () => {
  it("aborts pre-flop with refund obligations and restores stacks", () => {
    let s = seatPlayers(makeTable(3), [100n * K, 100n * K, 100n * K]);
    s = startHand(s, fullDeck());
    s = apply(s, { type: "POST_BLIND", playerId: "P1" }); // SB paid
    const r = E.reduce(s, { type: "ABORT_HAND", reason: "blind payment failed" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s1 = r.transition.nextState;
    expect(s1.aborted).toBe(true);
    expect(s1.phase).toBe("WAITING");
    expect(r.transition.obligations).toEqual([
      {
        kind: "PAY_PLAYER",
        playerId: "P1",
        amount: SB,
        reason: "REFUND",
        obligationId: `${s.handId}:${s1.sequence}:REFUND:P1`,
      },
    ]);
    expect(s1.seats[1]!.stack).toBe(100n * K);
  });

  it("is deterministic: identical action sequences produce identical states", () => {
    const script = () => {
      let s = readyHand([100n * K, 100n * K, 100n * K], fullDeck());
      s = apply(s, { type: "CALL", playerId: "P0" });
      s = apply(s, { type: "RAISE", playerId: "P1", amount: 8n * K });
      s = apply(s, { type: "FOLD", playerId: "P2" });
      s = apply(s, { type: "CALL", playerId: "P0" });
      return stateKey(s);
    };
    expect(script()).toBe(script());
  });
});

describe("conservation across a full multi-street hand", () => {
  it("conserves value through flop, turn, river and showdown", () => {
    const deck = buildDeck([1, 2, 0], { 0: ["Ah", "Kd"], 1: ["Qh", "Jd"], 2: ["2c", "3c"] }, [
      "Ac",
      "7c",
      "8c",
      "4d",
      "5s",
    ]);
    let s = seatPlayers(makeTable(3), [100n * K, 100n * K, 100n * K]);
    const t0 = initialTotal(s);
    s = startHand(s, deck);
    s = postBlinds(s);
    s = apply(s, { type: "CALL", playerId: "P0" });
    s = apply(s, { type: "CALL", playerId: "P1" });
    s = apply(s, { type: "CHECK", playerId: "P2" });
    expect(s.street).toBe("FLOP");
    s = apply(s, { type: "BET", playerId: "P1", amount: 10n * K });
    s = apply(s, { type: "FOLD", playerId: "P2" });
    s = apply(s, { type: "CALL", playerId: "P0" });
    expect(s.street).toBe("TURN");
    s = apply(s, { type: "CHECK", playerId: "P1" });
    s = apply(s, { type: "BET", playerId: "P0", amount: 20n * K });
    s = apply(s, { type: "CALL", playerId: "P1" });
    expect(s.street).toBe("RIVER");
    s = apply(s, { type: "CHECK", playerId: "P1" });
    s = apply(s, { type: "BET", playerId: "P0", amount: 40n * K });
    s = apply(s, { type: "FOLD", playerId: "P1" });
    expect(s.phase).toBe("SETTLEMENT");
    s = apply(s, { type: "DISTRIBUTE_POTS" });
    assertConserved(s, t0);
    // P0: contributed 72CKB, won the 106CKB pot -> 134CKB.
    expect(s.seats[0]!.stack).toBe(134n * K);
  });
});
