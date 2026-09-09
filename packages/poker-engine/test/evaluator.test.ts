import { describe, expect, it } from "vitest";

import { cardFromString } from "../src/cards.ts";
import { compareHands, evaluateHoleAndBoard } from "../src/evaluator.ts";

const cards = (...cs: string[]) => cs.map(cardFromString);

function best(...cards: string[]): number {
  return evaluateHoleAndBoard(cards.map(cardFromString)).value;
}

function category(...cards: string[]): string {
  const r = evaluateHoleAndBoard(cards.map(cardFromString));
  const names = [
    "high_card",
    "pair",
    "two_pair",
    "trips",
    "straight",
    "flush",
    "full_house",
    "quads",
    "straight_flush",
  ];
  return names[r.category]!;
}

describe("hand evaluator", () => {
  it("ranks categories in order", () => {
    expect(category("2h", "3d", "5c", "7s", "9h")).toBe("high_card");
    expect(category("2h", "2d", "5c", "7s", "9h")).toBe("pair");
    expect(category("2h", "2d", "5c", "5s", "9h")).toBe("two_pair");
    expect(category("2h", "2d", "2c", "7s", "9h")).toBe("trips");
    expect(category("2h", "3d", "4c", "5s", "6h")).toBe("straight");
    expect(category("2h", "3h", "5h", "7h", "9h")).toBe("flush");
    expect(category("2h", "2d", "2c", "3s", "3h")).toBe("full_house");
    expect(category("2h", "2d", "2c", "2s", "3h")).toBe("quads");
    expect(category("2h", "3h", "4h", "5h", "6h")).toBe("straight_flush");
  });

  it("detects the wheel as a straight", () => {
    expect(category("Ah", "2d", "3c", "4s", "5h")).toBe("straight");
    const wheel = evaluateHoleAndBoard(cards("Ah", "2d", "3c", "4s", "5h"));
    const sixHigh = evaluateHoleAndBoard(cards("2h", "3d", "4c", "5s", "6h"));
    expect(wheel.tiebreakers[0]).toBe(3);
    expect(compareHands(wheel, sixHigh)).toBe(-1);
  });

  it("ties identical-valued hands", () => {
    const a = best("Ah", "Kd", "9c", "7s", "4h");
    const b = best("Ad", "Kc", "9h", "7d", "4d");
    expect(a).toBe(b);
  });

  it("compares kickers exactly", () => {
    const a = best("Ah", "Ad", "Kc", "9s", "4h");
    const b = best("Ac", "As", "Kd", "8s", "4d");
    expect(a).toBeGreaterThan(b);
  });

  it("picks the best 5 of 7", () => {
    // Board: straight on board; hole [As, Ad] gives trip aces (better than straight? no: A2345 straight vs set) — use clean case:
    // board 2h 3h 4h 5h 9c, hole Ah Kh -> straight flush A2345 hearts
    const v = best("2h", "3h", "4h", "5h", "9c", "Ah", "Kh");
    const straightFlush = best("Ah", "2h", "3h", "4h", "5h");
    expect(v).toBe(straightFlush);
  });

  it("prefers full house over flush", () => {
    const fh = best("2h", "2d", "2c", "9s", "9h");
    const fl = best("Ah", "Kh", "Qh", "Jh", "3h");
    expect(fh).toBeGreaterThan(fl);
  });

  it("splits exactly on community straights", () => {
    const board = ["5h", "6d", "7c", "8s", "9h"];
    const p1 = best(...board, "Ah", "2d");
    const p2 = best(...board, "Kc", "Qd");
    expect(p1).toBe(p2);
  });
});
