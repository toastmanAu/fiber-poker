import { describe, expect, it, vi, afterEach } from "vitest";
import { publicView, nextStateHash } from "@fiber-poker/protocol";
import { fullDeck } from "@fiber-poker/poker-engine";
import { computeCommitment } from "@fiber-poker/deck";
import {
  apply,
  readyHand,
  actor,
  makeTable,
  seatPlayers,
  postBlinds,
} from "../../packages/poker-engine/test/harness.ts";
import {
  sliderAmount,
  validateAction,
  wagerAction,
  type YourTurn,
} from "../../apps/web-client/src/actions.ts";
import {
  displayedPot,
  formatCkb,
  payoutsCommitted,
  seatMapping,
} from "../../apps/web-client/src/table3d/stateAdapter.ts";
import { auditReveal } from "../../apps/web-client/src/audit.ts";
import { PokerSession } from "../../apps/web-client/src/session.ts";
const K = 100_000_000n;
const turn: YourTurn = {
  handId: "hand-1",
  sequence: "1",
  deadlineUnixMs: Date.now() + 30000,
  legal: {
    actions: ["BET", "CHECK", "FOLD", "ALL_IN"],
    callAmount: "0",
    minRaiseTo: "200000000",
    maxRaiseTo: "10000000000",
  },
};
afterEach(() => vi.unstubAllGlobals());

describe("browser view boundaries", () => {
  it("submits BET exactly, clamps the slider with integer precision, and rejects unadvertised actions", () => {
    expect(wagerAction(turn)).toBe("BET");
    expect(() =>
      validateAction(turn, { type: "RAISE", amount: 2n * K }),
    ).toThrow();
    expect(sliderAmount(turn, -20)).toBe(2n * K);
    expect(sliderAmount(turn, 120)).toBe(100n * K);
    expect(() =>
      validateAction(turn, { type: "BET", amount: 101n * K }),
    ).toThrow();
    expect(formatCkb("900719925474099312345678")).toBe(
      "9007199254740993.12345678",
    );
  });
  it("rotates all six logical seats without changing authoritative seats", () => {
    const state = publicView(readyHand(Array(6).fill(100n * K)));
    const before = JSON.stringify(state);
    expect(seatMapping(state, "P4").find((m) => m.local)?.slot).toBe(0);
    expect(new Set(seatMapping(state, "P4").map((m) => m.slot)).size).toBe(6);
    expect(JSON.stringify(state)).toBe(before);
  });
  it("uses committed contributions until pots exist; payout animation waits for completion that clears handId/awards", () => {
    let state = readyHand([100n * K, 100n * K]);
    expect(displayedPot(publicView(state))).toBe((3n * K).toString());
    const previous = publicView(state);
    state = apply(state, { type: "FOLD", playerId: actor(state) });
    const settlement = publicView(state);
    expect(payoutsCommitted(previous, settlement)).toBe(false);
    const complete = publicView(apply(state, { type: "DISTRIBUTE_POTS" }));
    expect(complete.handId).toBe("");
    expect(complete.awards).toEqual([]);
    expect(payoutsCommitted(settlement, complete)).toBe(true);
  });
  it("audits numeric cards and a hand ended before five board cards, bound to the observed commitment", () => {
    const handId = "audit-hand",
      permutation = fullDeck(),
      nonce = "00".repeat(16);
    const commitment = computeCommitment(handId, permutation, nonce);
    let state = seatPlayers(makeTable(3), [100n * K, 100n * K, 100n * K]);
    state = apply(state, { type: "SIT_OUT", playerId: "P2" });
    state = apply(state, {
      type: "START_HAND",
      handId,
      deck: permutation,
      deckCommitment: commitment,
    });
    state = postBlinds(state);
    const reveal = { handId, permutation, nonce, commitment };
    expect(auditReveal(reveal, publicView(state), []).dealingOk).toBe(true);
    expect(
      auditReveal(reveal, { ...publicView(state), deckCommitment: "wrong" }, [])
        .commitmentOk,
    ).toBe(false);
    expect(auditReveal(reveal, publicView(state), [51, 50, 49]).dealingOk).toBe(
      false,
    );
  });
  it("keeps payment success pending until commit, cancels failure, clears old cards, and flags broken hashes", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const s = new PokerSession("ws://localhost");
    const internal = s as unknown as {
      ingest: (m: Record<string, unknown>) => void;
      ws: { readyState: number; send: ReturnType<typeof vi.fn> };
    };
    internal.ws = { readyState: 1, send: vi.fn() };
    const view = publicView(readyHand([100n * K, 100n * K]));
    internal.ingest({ type: "TABLE_SNAPSHOT", payload: { state: view } });
    internal.ingest({
      type: "HOLE_CARDS",
      payload: { handId: view.handId, cards: [0, 1] },
    });
    expect(s.holeCards).toEqual([0, 1]);
    internal.ingest({ type: "PAYMENT_REQUIRED", payload: {} });
    internal.ingest({
      type: "PAYMENT_STATUS",
      payload: { status: "SUCCEEDED" },
    });
    expect(s.status.paymentPending).toBe(true);
    expect(s.tableState).toEqual(view);
    for (const status of ["PAYMENT_SUBMITTED", "PAYMENT_FAILED"]) {
      internal.ingest({ type: "COMPANION_STATUS", payload: { status } });
      expect(s.companionStatus).toBe(status);
      expect(s.status.paymentPending).toBe(true);
      expect(s.tableState).toEqual(view);
    }
    internal.ingest({ type: "PAYMENT_STATUS", payload: { status: "FAILED" } });
    expect(s.status.paymentPending).toBe(false);
    expect(s.tableState).toEqual(view);
    const state = {
      ...view,
      sequence: String(BigInt(view.sequence) + 1n),
      handId: "new-hand",
    };
    const zero = "00".repeat(32);
    internal.ingest({ type: "PAYMENT_REQUIRED", payload: {} });
    internal.ingest({
      type: "STATE_COMMIT",
      payload: {
        state,
        previousStateHash: zero,
        actionHash: zero,
        stateHash: nextStateHash(zero, zero, state),
      },
    });
    expect(s.status.paymentPending).toBe(false);
    expect(s.holeCards).toEqual([]);
    expect(s.chain.verifiedCount).toBe(1);
    internal.ingest({
      type: "HOLE_CARDS",
      payload: { handId: view.handId, cards: [0, 1] },
    });
    expect(s.holeCards).toEqual([]);
    internal.ingest({
      type: "STATE_COMMIT",
      payload: {
        state,
        previousStateHash: zero,
        actionHash: zero,
        stateHash: zero,
      },
    });
    expect(s.chain.broken).toBe(true);
  });
});
