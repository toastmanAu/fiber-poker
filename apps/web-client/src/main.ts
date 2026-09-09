/**
 * Fiber Poker browser client entrypoint.
 *
 * UX rules (docs/15): network connected, table session, channel ready, seat
 * ready, payment pending, sitting out and reconnecting are shown as
 * SEPARATE indicators — never collapsed into one "online" dot.
 */

import "./style.css";
import { PokerSession } from "./session.ts";
import { auditReveal, type AuditResult } from "./audit.ts";
import { cardToString, cardFromString, type Card } from "@fiber-poker/poker-engine";
import type { DeckReveal } from "@fiber-poker/deck";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

let session: PokerSession | null = null;
let lastHandStart: import("@fiber-poker/protocol").PublicTableState | null = null;
let lastBoard: number[] = [];
let lastReveal: { reveal: DeckReveal; audit: AuditResult; handId: string } | null = null;
const history: string[] = [];

function chip(label: string, cls = ""): string {
  return `<span class="chip ${cls}">${label}</span>`;
}

function renderStatus(): void {
  if (!session) return;
  const s = session.status;
  const chips: string[] = [];
  chips.push(s.wsConnected ? chip("server ✔", "ok") : chip("server ✘", s.reconnecting ? "warn" : "bad"));
  chips.push(s.authenticated ? chip("session ✔", "ok") : chip("session …", ""));
  chips.push(s.channelReady ? chip("channel ✔", "ok") : chip("channel …", ""));
  chips.push(s.seatReady ? chip("seat ✔", "ok") : chip("seat …", ""));
  if (s.paymentPending) chips.push(chip("payment pending", "warn"));
  if (s.sittingOut) chips.push(chip("sitting out", "warn"));
  if (s.reconnecting) chips.push(chip("reconnecting", "warn"));
  if (session.chain.broken) chips.push(chip("CHAIN BROKEN", "bad"));
  else if (session.chain.verifiedCount > 0) chips.push(chip(`chain ✓${session.chain.verifiedCount}`, "ok"));
  if (session.devMode.fakeSettlement) chips.push(chip("DEV fake settlement", "warn"));
  $("status-chips").innerHTML = chips.join("");
}

function cardHtml(card: string, small = false): string {
  const c: Card = cardFromString(card);
  const red = card.endsWith("h") || card.endsWith("d");
  return `<span class="card ${red ? "red" : ""} ${small ? "small" : ""}">${cardToString(c)}</span>`;
}

function renderSeats(): void {
  if (!session?.tableState) return;
  const st = session.tableState;
  const seatsEl = $("seats");
  const positions = [
    { left: "50%", top: "-6px" },
    { left: "88%", top: "28%" },
    { left: "72%", top: "88%" },
    { left: "28%", top: "88%" },
    { left: "12%", top: "28%" },
    { left: "50%", top: "46%" },
  ];
  seatsEl.innerHTML = st.seats
    .map((s) => {
      if (!s.playerId) return "";
      const idx = s.seat % 6;
      const pos = positions[idx]!;
      const isMe = s.playerId === session!.pubkey;
      const acting = st.actingSeat === s.seat;
      const cards = isMe && session!.holeCards.length === 2
        ? session!.holeCards.map((c) => cardHtml(c, true)).join("")
        : s.holeCardsHash
          ? `<span class="card back small">?</span><span class="card back small">?</span>`
          : "";
      const bet = BigInt(s.streetContribution) > 0n ? `<div class="bet">bet ${formatCkb(s.streetContribution)}</div>` : "";
      const chipIcon = st.buttonSeat === s.seat ? '<span class="dealer-btn">D</span>' : "";
      return `<div class="seat ${acting ? "acting" : ""} ${s.folded ? "folded" : ""}" style="left:${pos.left};top:${pos.top}">
        ${chipIcon}
        <div class="avatar">${isMe ? "ME" : s.seat + 1}</div>
        <div class="stack">${formatCkb(s.stack)}</div>
        ${bet}
        <div class="cards">${cards}</div>
        <div class="name">${isMe ? "you" : `player ${short(s.playerId)}`}</div>
      </div>`;
    })
    .join("");
  $("board").innerHTML = st.board.map((c) => cardHtml(cardToString(cardFromString(String(c))))).join("");
  const pot = st.pots.reduce((a, p) => a + BigInt(p.amount), 0n);
  $("pot").textContent = pot > 0n ? `pot ${formatCkb(pot.toString())}` : "";
  $("hand-info").textContent = st.handId
    ? `hand ${st.handNo} · ${st.phase}${st.street ? ` · ${st.street}` : ""} · seq ${st.sequence} · blinds ${formatCkb(st.config.smallBlind)}/${formatCkb(st.config.bigBlind)}`
    : `waiting between hands · seq ${st.sequence}`;
}

function formatCkb(shannons: string): string {
  const v = BigInt(shannons);
  return `${Number(v / 100_000_000n)}.${String(Number(v % 100_000_000n)).padStart(8, "0").slice(0, 2)} CKB`;
}

function short(pubkey: string): string {
  return `${pubkey.slice(0, 6)}…`;
}

function renderActions(): void {
  if (!session) return;
  const turn = session.yourTurn as { legal?: { actions: string[]; callAmount: string; minRaiseTo: string; maxRaiseTo: string }; deadlineUnixMs?: number } | null;
  const buttons = $("action-buttons");
  const statusEl = $("action-status");
  if (!turn || !turn.legal || turn.legal.actions.length === 0) {
    statusEl.textContent = session.status.paymentPending
      ? "payment in flight…"
      : session.status.sittingOut
        ? "sitting out"
        : "waiting for other players…";
    buttons.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
    return;
  }
  const actions = turn.legal.actions;
  statusEl.textContent = `your turn — to call ${formatCkb(turn.legal.callAmount)}`;
  ($("btn-fold") as HTMLButtonElement).disabled = !actions.includes("FOLD");
  ($("btn-check") as HTMLButtonElement).disabled = !actions.includes("CHECK");
  ($("btn-call") as HTMLButtonElement).disabled = !actions.includes("CALL");
  const canRaise = actions.includes("RAISE") || actions.includes("BET");
  ($("btn-raise") as HTMLButtonElement).disabled = !canRaise;
  ($("raise-slider") as HTMLInputElement).disabled = !canRaise;
  const slider = $("raise-slider") as HTMLInputElement;
  const min = BigInt(turn.legal.minRaiseTo);
  const max = BigInt(turn.legal.maxRaiseTo);
  slider.min = "0";
  slider.max = "100";
  slider.dataset.min = min.toString();
  slider.dataset.max = max.toString();
  if (turn.deadlineUnixMs) {
    const secs = Math.max(0, Math.round((turn.deadlineUnixMs - Date.now()) / 1000));
    statusEl.textContent += ` · ${secs}s`;
  }
}

function pushHistory(entry: string): void {
  history.unshift(entry);
  if (history.length > 20) history.pop();
  $("history").innerHTML = history.map((h) => `<div class="entry">${h}</div>`).join("");
}

function renderAudit(): void {
  const el = $("deck-audit");
  if (!lastReveal) {
    el.innerHTML = "No hand revealed yet.";
    return;
  }
  const { audit, handId } = lastReveal;
  el.innerHTML = `
    <div class="entry">hand <strong>${handId.slice(-12)}</strong></div>
    <div class="entry">commitment: ${audit.commitmentOk ? '<span class="ok">verified</span>' : '<span class="bad">MISMATCH</span>'}</div>
    <div class="entry">dealing: ${audit.dealingOk === true ? '<span class="ok">matches revealed deck</span>' : audit.dealingOk === false ? '<span class="bad">MISMATCH</span>' : "not fully verifiable"}</div>
    <div>${audit.detail}</div>
    <div class="entry" style="margin-top:6px">Note: verifies the deck was not changed after commitment. The server still saw all cards (V0).</div>`;
}

async function boot(): Promise<void> {
  ($("dev-autopay") as HTMLInputElement).checked = true;
  $("btn-join").addEventListener("click", () => {
    const url = ($("ws-url") as HTMLInputElement).value.trim();
    const buyIn = Number(($("buy-in") as HTMLInputElement).value) || 100;
    void start(url, buyIn);
  });
}

async function start(url: string, buyIn: number): Promise<void> {
  $("btn-join").setAttribute("disabled", "true");
  session = new PokerSession(url);
  session.on("status", () => {
    renderStatus();
    renderActions();
  });
  session.on("*", () => {
    /* status refresh hook */
  });
  session.on("STATE_COMMIT", () => {
    renderSeats();
    session!.yourTurn = null;
    renderActions();
  });
  session.on("TABLE_SNAPSHOT", () => {
    renderSeats();
    switchToTable();
  });
  session.on("HAND_START", () => {
    lastHandStart = session!.tableState;
    lastBoard = [];
    pushHistory(`hand started (commitment ${String((session!.chain.sequence))})`);
  });
  session.on("STREET_CHANGED", () => renderSeats());
  session.on("HAND_RESULT", (msg) => {
    const p = msg.payload as { awards: { playerId: string; amount: string }[]; board: number[]; showdowns: { playerId: string; cards: string[] }[] };
    lastBoard = p.board;
    for (const a of p.awards.slice(0, 3)) {
      pushHistory(`award: ${short(a.playerId)} +${formatCkb(a.amount)}`);
    }
  });
  session.on("DECK_REVEALED", (msg) => {
    const reveal = msg.payload as unknown as DeckReveal;
    const handId = reveal.handId;
    const audit = lastHandStart
      ? auditReveal(reveal, lastHandStart, lastBoard)
      : { commitmentOk: false, dealingOk: null, detail: "no hand-start state captured" };
    lastReveal = { reveal, audit, handId };
    renderAudit();
    pushHistory(`deck revealed ${audit.commitmentOk ? "✔" : "✘"}`);
  });
  session.on("SEAT_STATUS", (msg) => {
    const lifecycle = (msg.payload as { lifecycle: string }).lifecycle;
    pushHistory(`status: ${lifecycle}`);
  });
  session.on("YOUR_TURN", () => renderActions());
  session.on("ACTION_REJECTED", (msg) => {
    const p = msg.payload as { code: string; detail: string };
    pushHistory(`action rejected: ${p.code}`);
  });

  try {
    setStatusText("connecting…");
    await session.connect();
    setStatusText("authenticating…");
    await session.authenticate();
    setStatusText("joining…");
    await session.join(buyIn);
    setStatusText("waiting for table snapshot…");
    await new Promise<void>((resolve) => {
      const done = (): void => {
        session!.off("TABLE_SNAPSHOT", done);
        resolve();
      };
      session!.on("TABLE_SNAPSHOT", done);
      setTimeout(resolve, 8000);
    });
    switchToTable();
  } catch (e) {
    $("btn-join").removeAttribute("disabled");
    setStatusText(`join failed: ${String(e)}`);
  }
}

function setStatusText(text: string): void {
  const el = $("action-status") ?? document.getElementById("hand-info");
  const target = document.getElementById("hand-info");
  if (target) target.textContent = text;
}

function switchToTable(): void {
  $("screen-connect").classList.add("hidden");
  $("screen-table").classList.remove("hidden");
  renderSeats();
  renderStatus();
}

// action buttons — wired immediately; DOM is already parsed (module script)
function wire(): void {
  (window as unknown as { __pokerWired?: boolean }).__pokerWired = true;
  window.addEventListener("error", (e) => {
    (window as unknown as { __errs?: string[] }).__errs = ((window as unknown as { __errs?: string[] }).__errs ?? []).concat(String(e.message));
  });
  window.addEventListener("unhandledrejection", (e) => {
    (window as unknown as { __errs?: string[] }).__errs = ((window as unknown as { __errs?: string[] }).__errs ?? []).concat("rejection: " + String(e.reason));
  });
  void boot();
  $("btn-fold").addEventListener("click", () => void session?.act({ type: "FOLD" }));
  $("btn-check").addEventListener("click", () => void session?.act({ type: "CHECK" }));
  $("btn-call").addEventListener("click", () => void session?.act({ type: "CALL" }));
  $("btn-raise").addEventListener("click", () => {
    const slider = $("raise-slider") as HTMLInputElement;
    const min = BigInt(slider.dataset.min ?? "0");
    const max = BigInt(slider.dataset.max ?? "0");
    const frac = Number(slider.value) / 100;
    const to = min + ((max - min) * BigInt(Math.round(frac * 100))) / 100n;
    void session?.act({ type: "RAISE", amount: to });
  });
  $("deck-audit").addEventListener("click", () => {
    if (lastReveal) session?.requestDeckAudit(lastReveal.handId);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire);
} else {
  wire();
}
