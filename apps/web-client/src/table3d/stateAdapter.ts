import type { PublicTableState } from "@fiber-poker/protocol";
import { cardToString } from "@fiber-poker/poker-engine";

/** Display-only conversions; all amounts and seat numbers remain authoritative. */
export function formatCkb(value: string): string {
  const n = BigInt(value);
  const fraction = (n % 100_000_000n)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  return `${n / 100_000_000n}${fraction ? `.${fraction}` : ""}`;
}
export function cardLabel(card: number | string): string {
  return typeof card === "number" ? cardToString(card) : card;
}
export function visualSeat(seat: number, localSeat = 0): number {
  return (seat - localSeat + 6) % 6;
}
export const SEAT_POSITIONS = [
  [0, 3.8],
  [2.3, 1.8],
  [2.25, -2.15],
  [0, -3.85],
  [-2.25, -2.15],
  [-2.3, 1.8],
] as const;
export function seatMapping(state: PublicTableState, localId: string) {
  const local = state.seats.find((s) => s.playerId === localId)?.seat ?? 0;
  return state.seats.map((seat) => ({
    seat,
    slot: visualSeat(seat.seat, local),
    local: seat.playerId === localId,
  }));
}
export function displayedPot(state: PublicTableState): string {
  // Engine materializes side pots at SETTLEMENT; before that contributions ARE the pot.
  return (
    state.pots.length
      ? state.pots.reduce((n, p) => n + BigInt(p.amount), 0n)
      : state.seats.reduce((n, s) => n + BigInt(s.handContribution), 0n)
  ).toString();
}
export function payoutsCommitted(
  previous: PublicTableState | null,
  next: PublicTableState,
): boolean {
  return (
    previous?.phase === "SETTLEMENT" &&
    previous.handNo === next.handNo &&
    next.phase === "HAND_COMPLETE"
  );
}
