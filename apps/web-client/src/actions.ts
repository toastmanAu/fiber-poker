export type PlayerAction =
  | "FOLD"
  | "CHECK"
  | "CALL"
  | "BET"
  | "RAISE"
  | "ALL_IN";
export interface YourTurn {
  handId: string;
  sequence: string;
  deadlineUnixMs: number;
  legal: {
    actions: PlayerAction[];
    callAmount: string;
    minRaiseTo: string;
    maxRaiseTo: string;
  };
}
export function wagerAction(turn: YourTurn | null): "BET" | "RAISE" | null {
  return turn?.legal.actions.includes("BET")
    ? "BET"
    : turn?.legal.actions.includes("RAISE")
      ? "RAISE"
      : null;
}
export function sliderAmount(turn: YourTurn, percent: number): bigint {
  const min = BigInt(turn.legal.minRaiseTo),
    max = BigInt(turn.legal.maxRaiseTo);
  const clamped = BigInt(
    Math.round(
      Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0)),
    ),
  );
  return min + ((max - min) * clamped) / 100n;
}
export function validateAction(
  turn: YourTurn | null,
  action: { type: string; amount?: bigint },
): void {
  if (!turn?.legal.actions.includes(action.type as PlayerAction))
    throw new Error("This action is no longer advertised by the server.");
  if (
    (action.type === "BET" || action.type === "RAISE") &&
    (action.amount === undefined ||
      action.amount < BigInt(turn.legal.minRaiseTo) ||
      action.amount > BigInt(turn.legal.maxRaiseTo))
  )
    throw new Error("Amount is outside the server's legal range.");
}
