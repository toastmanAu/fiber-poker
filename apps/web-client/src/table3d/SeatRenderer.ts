import type { PublicTableState } from "@fiber-poker/protocol";
import { formatCkb } from "./stateAdapter.ts";

export class SeatRenderer {
  readonly element = document.createElement("div");
  private identity = document.createElement("div");
  private stack = document.createElement("strong");
  private detail = document.createElement("div");
  private channel = document.createElement("i");
  private clock = document.createElement("span");
  constructor(root: HTMLElement, slot: number) {
    this.element.className = "player-label empty";
    this.element.dataset.slot = String(slot);
    this.identity.className = "player-name";
    this.stack.className = "player-stack";
    this.detail.className = "player-detail";
    this.channel.className = "channel-dot";
    this.clock.className = "seat-clock";
    this.element.append(
      this.channel,
      this.identity,
      this.stack,
      this.detail,
      this.clock,
    );
    root.append(this.element);
    this.identity.textContent = "Open seat";
  }
  sync(
    seat: PublicTableState["seats"][number] | undefined,
    state: PublicTableState,
    local: boolean,
  ): void {
    const occupied = !!seat?.playerId;
    this.element.className = `player-label ${occupied ? "" : "empty"} ${local ? "local" : ""} ${seat?.folded || seat?.sittingOut ? "subdued" : ""} ${occupied && state.actingSeat === seat?.seat ? "acting" : ""}`;
    this.identity.textContent = occupied
      ? `${local ? "YOU" : seat!.playerId!.slice(0, 6)} · ${seat!.seat + 1}`
      : "Open seat";
    this.stack.textContent = occupied ? `${formatCkb(seat!.stack)} CKB` : "";
    const markers = seat
      ? [
          state.buttonSeat === seat.seat ? "D" : "",
          state.smallBlindSeat === seat.seat ? "SB" : "",
          state.bigBlindSeat === seat.seat ? "BB" : "",
        ].filter(Boolean)
      : [];
    this.detail.textContent = occupied
      ? [
          ...markers,
          seat!.sittingOut
            ? "Sitting out"
            : seat!.folded
              ? "Folded"
              : seat!.allIn
                ? "All-in"
                : BigInt(seat!.streetContribution) > 0n
                  ? `Bet ${formatCkb(seat!.streetContribution)}`
                  : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    this.element.title = occupied
      ? `${seat!.playerId}\nHand contribution: ${formatCkb(seat!.handContribution)} CKB\n${local ? "Local channel status shown above" : "Remote channel readiness is not broadcast"}`
      : "Empty logical seat";
    this.channel.hidden = !occupied;
    this.channel.classList.toggle("known", local);
    this.channel.title = local
      ? "See local channel status"
      : "Channel status unreported";
  }
  award(amount: string): void {
    this.element.classList.add("winner");
    this.detail.textContent = `Won ${formatCkb(amount)} CKB`;
  }
  timer(seconds: number | null, fraction = 0): void {
    this.clock.textContent = seconds === null ? "" : `${seconds}s`;
    this.element.style.setProperty("--remaining", `${fraction * 100}%`);
  }
  position(x: number, y: number): void {
    this.element.style.left = `${x}px`;
    this.element.style.top = `${y}px`;
  }
  dispose(): void {
    this.element.remove();
  }
}
