import { parseAgentIdentity } from "./identity.ts";
import "./style.css";
import { PokerSession } from "./session.ts";
import { auditReveal } from "./audit.ts";
import type { DeckReveal } from "@fiber-poker/deck";
import type { PublicTableState } from "@fiber-poker/protocol";
import { TableScene, type HandResult } from "./table3d/TableScene.ts";
import {
  cardLabel,
  displayedPot,
  formatCkb,
  payoutsCommitted,
} from "./table3d/stateAdapter.ts";
import { sliderAmount, wagerAction } from "./actions.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
let session: PokerSession | null = null;
let agentIdentity: ReturnType<typeof parseAgentIdentity> | undefined;
let identityRead = 0;
let scene: TableScene | null = null;
let lastDisplayed: PublicTableState | null = null;
let lastRevealId = "";
let turnKey = "";
let turnDuration = 1;
let paymentFailed = false;
const audits = new Map<string, { start: PublicTableState; board: number[] }>();
const history: string[] = [];
const amount = (value: string) => `${formatCkb(value)} CKB`;
const short = (id: string) => `${id.slice(0, 6)}…`;

function pushHistory(entry: string): void {
  history.unshift(
    `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ${entry}`,
  );
  history.splice(60);
  $("history").replaceChildren(
    ...history.map((text) => {
      const row = document.createElement("div");
      row.className = "entry";
      row.textContent = text;
      return row;
    }),
  );
}
function renderStatus(): void {
  if (!session) return;
  const s = session.status;
  const flags: [string, string][] = [
    [
      s.wsConnected ? "Server connected" : "Server offline",
      s.wsConnected ? "ok" : "bad",
    ],
    [
      s.authenticated ? "Authenticated" : "Session unverified",
      s.authenticated ? "ok" : "",
    ],
    [
      s.channelReady ? "Channel ready" : "Channel unconfirmed",
      s.channelReady ? "ok" : "",
    ],
    [s.seatReady ? "Seat ready" : "Seat pending", s.seatReady ? "ok" : ""],
    [
      `Chain ${session.chain.verifiedCount} verified`,
      session.chain.broken ? "bad" : "ok",
    ],
  ];
  if (session.companionStatus)
    flags.push([
      session.companionStatus === "PAYMENT_FAILED"
        ? "Companion payment failed"
        : session.companionStatus === "OBSERVE_ONLY"
          ? "Companion · payments disabled"
          : "Local companion connected",
      ["PAYMENT_FAILED", "OBSERVE_ONLY"].includes(session.companionStatus)
        ? "warn"
        : "ok",
    ]);
  if (s.reconnecting) flags.push(["Reconnecting", "warn"]);
  if (s.sittingOut) flags.push(["Sitting out", "warn"]);
  if (s.paymentPending) flags.push(["Payment pending", "warn"]);
  if (session.devMode.fakeSettlement)
    flags.push(["DEV · FAKE SETTLEMENT", "warn dev"]);
  $("status-chips").replaceChildren(
    ...flags.map(([text, css]) => {
      const el = document.createElement("span");
      el.textContent = text;
      el.className = `status-chip ${css}`;
      return el;
    }),
  );
  $("chain-alert").hidden = !session.chain.broken;
  $("chain-details").textContent =
    `${session.chain.broken ? "CHAIN BROKEN" : "Chain links and public-state hashes checked"} · ${session.chain.verifiedCount} verified commits\nSequence ${session.chain.sequence}\n${session.chain.stateHash}\nSnapshot establishes a baseline; it does not verify missing history.`;
  $("chain-details").className = session.chain.broken ? "bad" : "";
  $("connection-details").textContent =
    `Server: ${$<HTMLInputElement>("ws-url").value}\nIdentity: ${session.pubkey}\nWebSocket: ${s.wsConnected}\nAuthenticated: ${s.authenticated}\nChannel ready: ${s.channelReady}\nSeat ready: ${s.seatReady}\nReconnecting: ${s.reconnecting}\nSitting out: ${s.sittingOut}\nPayment pending: ${s.paymentPending}\nSettlement: ${session.devMode.fakeSettlement ? "DEV fake settlement" : "Server-coordinated Fiber (mode not advertised)"}\nAuto-pay: ${session.devMode.autoPay}\nChannel details: ${JSON.stringify(session.channelDetails)}\nLocal companion: ${session.companionStatus || "not connected"}`;
  const pending = $("payment-status");
  pending.className = `payment-status ${s.paymentPending ? "pending" : paymentFailed ? "failed" : ""}`;
  pending.textContent = s.paymentPending
    ? session.companionStatus === "PAYMENT_FAILED"
      ? "Companion payment failed · awaiting table resolution"
      : "◌ Fiber payment pending · awaiting committed state"
    : paymentFailed
      ? "Payment failed · action was not committed"
      : "● Table settlement endpoint · Fiber";
  scene?.setConnectionStatus(s);
  scene?.setPaymentPending(s.paymentPending);
  renderActions();
}
function renderTable(animate = true): void {
  const st = session?.tableState;
  if (!st || !session) return;
  if (payoutsCommitted(lastDisplayed, st)) {
    for (const award of lastDisplayed!.awards)
      pushHistory(
        `Payout committed · ${short(award.playerId)} +${amount(award.amount)} · pots ${award.potIds.join(", ")}`,
      );
  }
  lastDisplayed = st;
  scene?.syncState(st, session.pubkey, session.holeCards, animate);
  $("hand-info").textContent =
    `HAND ${st.handNo} · ${st.street ?? st.phase} · ${amount(st.config.smallBlind)}/${formatCkb(st.config.bigBlind)} blinds`;
  $("deck-commitment").textContent = st.deckCommitment
    ? `Hand ${st.handNo} commitment: ${st.deckCommitment}`
    : "No deck committed.";
  const audit = audits.get(st.handId);
  if (audit) {
    audit.board = st.board.slice();
    // START_HAND has no hole commitments. Capture the first post-blind deal commit.
    if (
      !audit.start.seats.some((s) => s.holeCardsHash) &&
      st.seats.some((s) => s.holeCardsHash)
    )
      audit.start = st;
  }
  $("table-details").replaceChildren(
    ...[
      `Hand ${st.handNo} · ${st.phase} · ${st.street ?? "—"} · sequence ${st.sequence}`,
      `Board: ${st.board.map(cardLabel).join(" ") || "Not dealt"} · Current bet: ${amount(st.currentBet)} · Pot: ${amount(displayedPot(st))}`,
      `Your cards: ${session.holeCards.map(cardLabel).join(" ") || "Not received for this hand"}`,
      ...st.seats.map(
        (s) =>
          `Seat ${s.seat + 1}: ${s.playerId ? short(s.playerId) : "empty"} · stack ${amount(s.stack)} · street ${amount(s.streetContribution)} · hand ${amount(s.handContribution)}${s.folded ? " · folded" : ""}${s.allIn ? " · all-in" : ""}${s.sittingOut ? " · sitting out" : ""}${st.actingSeat === s.seat ? " · acting" : ""}${st.buttonSeat === s.seat ? " · dealer" : ""}${st.smallBlindSeat === s.seat ? " · SB" : ""}${st.bigBlindSeat === s.seat ? " · BB" : ""}`,
      ),
      ...st.pots.map(
        (p) =>
          `Pot ${p.potId}: ${amount(p.amount)} · eligible ${p.eligiblePlayerIds.map(short).join(", ")}`,
      ),
      ...st.awards.map(
        (a) =>
          `${st.phase === "HAND_COMPLETE" ? "Paid" : "Award pending settlement"}: ${short(a.playerId)} · ${amount(a.amount)} · pots ${a.potIds.join(", ")}`,
      ),
      ...(st.aborted ? [`Hand aborted: ${st.abortReason}`] : []),
    ].map((text) => {
      const p = document.createElement("div");
      p.className = "entry";
      p.textContent = text;
      return p;
    }),
  );
}
function renderAmount(): void {
  const turn = session?.yourTurn;
  if (!turn) return;
  const value = sliderAmount(
    turn,
    Number($<HTMLInputElement>("raise-slider").value),
  );
  $("raise-amount").textContent = amount(value.toString());
  $("raise-slider").setAttribute("aria-valuetext", amount(value.toString()));
}
function renderActions(): void {
  const turn = session?.yourTurn ?? null;
  const key = turn ? `${turn.handId}:${turn.sequence}` : "";
  if (key !== turnKey) {
    turnKey = key;
    $<HTMLInputElement>("raise-slider").value = "0";
    turnDuration = Math.max(
      1,
      (turn?.deadlineUnixMs ?? Date.now()) - Date.now(),
    );
  }
  const locked =
    !session ||
    !session.status.wsConnected ||
    !session.status.authenticated ||
    session.status.reconnecting ||
    session.actionPending ||
    session.status.paymentPending;
  const actions = turn?.legal.actions ?? [];
  for (const [id, action] of [
    ["fold", "FOLD"],
    ["check", "CHECK"],
    ["call", "CALL"],
    ["all-in", "ALL_IN"],
  ] as const)
    $<HTMLButtonElement>(`btn-${id}`).disabled =
      locked || !actions.includes(action);
  const wager = wagerAction(turn);
  $<HTMLButtonElement>("btn-raise").disabled = locked || !wager;
  $<HTMLInputElement>("raise-slider").disabled = locked || !wager;
  $<HTMLButtonElement>("btn-min").disabled = locked || !wager;
  $("btn-raise").textContent = wager === "BET" ? "Bet" : "Raise";
  $("amount-label").textContent = wager === "BET" ? "Bet to" : "Raise to";
  $("raise-row").hidden = !wager;
  if (turn) {
    $("raise-min").textContent = `Min ${formatCkb(turn.legal.minRaiseTo)}`;
    $("raise-max").textContent = `Max ${formatCkb(turn.legal.maxRaiseTo)}`;
    renderAmount();
  }
  const seated = !!session?.tableState?.seats.some(
    (s) => s.playerId === session?.pubkey,
  );
  $<HTMLButtonElement>("btn-leave").disabled =
    !seated || !!session?.actionPending;
  $<HTMLButtonElement>("btn-topup").disabled =
    !seated || !!session?.status.paymentPending;
  $<HTMLInputElement>("top-up").disabled = !seated;
  $("action-status").textContent = session?.status.paymentPending
    ? "Payment pending · waiting for commit"
    : session?.actionPending
      ? "Action sent · waiting for commit"
      : session?.status.reconnecting
        ? "Reconnecting · waiting for resync"
        : session?.status.sittingOut
          ? "You are sitting out"
          : turn
            ? `Your turn · ${amount(turn.legal.callAmount)} to call`
            : "Waiting for the table…";
  scene?.setTurn(turn);
  renderClock();
}
function renderClock(): void {
  const turn = session?.yourTurn;
  const ms = Math.max(0, (turn?.deadlineUnixMs ?? 0) - Date.now());
  $("turn-clock").textContent = turn ? `${Math.ceil(ms / 1000)}s` : "—";
  $("turn-clock").style.setProperty(
    "--remaining",
    `${Math.min(1, ms / turnDuration) * 100}%`,
  );
}
async function submit(type: string, value?: bigint): Promise<void> {
  try {
    await session?.act({
      type,
      ...(value !== undefined ? { amount: value } : {}),
    });
  } catch (error) {
    pushHistory(String(error));
  }
  renderActions();
}
function showTable(): void {
  $("app").classList.add("playing");
  $("screen-connect").classList.add("hidden");
  $("screen-table").classList.remove("hidden");
  if (!scene && !$("table-stage").dataset.unavailable) {
    try {
      scene = new TableScene($("table-stage"), $("seat-overlays"));
    } catch (error) {
      $("scene-fallback").hidden = false;
      $("table-stage").dataset.unavailable = "true";
      pushHistory(`3D unavailable: ${String(error)}`);
    }
  }
  renderTable(false);
  renderStatus();
}
async function start(): Promise<void> {
  $<HTMLButtonElement>("btn-join").disabled = true;
  session?.dispose();
  session = new PokerSession(
    $<HTMLInputElement>("ws-url").value.trim(),
    agentIdentity,
  );
  const active = session;
  active.on("status", renderStatus);
  active.on("STATE_COMMIT", (msg) => {
    paymentFailed = false;
    renderTable();
    renderActions();
    const p = msg.payload as { summary?: unknown; state: PublicTableState };
    pushHistory(
      `Commit ${p.state.sequence} · ${typeof p.summary === "string" ? p.summary : JSON.stringify(p.summary ?? p.state.phase)}`,
    );
  });
  active.on("TABLE_SNAPSHOT", showTable);
  active.on("PLAYER_LEFT", (msg) => {
    const p = msg.payload as { playerId: string };
    if (p.playerId !== active.pubkey) return;
    pushHistory("Left the table · cash-out paid over your channel");
    $("join-status").textContent =
      "Left the table — your stack was paid out over your channel.";
    $("screen-connect").classList.remove("hidden");
    $("screen-table").classList.add("hidden");
    $("app").classList.remove("playing");
    $<HTMLButtonElement>("btn-join").disabled = false;
    if (session === active) {
      active.dispose();
      session = null;
    }
  });
  active.on("TOP_UP_APPLIED", (msg) => {
    const p = msg.payload as { amount?: string };
    const ckb = p.amount ? (Number(p.amount) / 1e8).toFixed(2) : "?";
    pushHistory(`Top-up applied · +${ckb} CKB`);
  });
  active.on("SEAT_STATUS", (msg) => {
    if ((msg.payload as { lifecycle?: string }).lifecycle === "TOP_UP_QUEUED")
      pushHistory("Top-up queued · applies between hands");
  });
  active.on("HOLE_CARDS", () => renderTable());
  active.on("HAND_START", (msg) => {
    const p = msg.payload as { state: PublicTableState };
    // HAND_START precedes STATE_COMMIT; capture for audit, never display early.
    audits.set(p.state.handId, { start: p.state, board: [] });
    if (audits.size > 20) audits.delete(audits.keys().next().value!);
    pushHistory(`Hand ${p.state.handNo} · deck committed`);
  });
  active.on("HAND_RESULT", (msg) => {
    const p = msg.payload as unknown as HandResult & {
      awards: { playerId: string; amount: string }[];
      board: number[];
    };
    scene?.handleHandResult(p);
    const audit = audits.get(p.handId);
    if (audit) audit.board = p.board;
    for (const a of p.awards)
      pushHistory(
        `Award announced · ${short(a.playerId)} ${amount(a.amount)} · payout pending`,
      );
  });
  active.on("DECK_REVEALED", (msg) => {
    const reveal = msg.payload as unknown as DeckReveal;
    const observed = audits.get(reveal.handId);
    const audit = observed
      ? auditReveal(reveal, observed.start, observed.board)
      : null;
    lastRevealId = reveal.handId;
    $("deck-audit").textContent =
      `Hand ${reveal.handId}\n${audit ? `Commitment: ${audit.commitmentOk ? "verified" : "MISMATCH"} · Dealing: ${audit.dealingOk === true ? "verified" : audit.dealingOk === false ? "MISMATCH" : "partial"}\n${audit.detail}` : "Full audit unavailable: this browser did not observe hand start."}\nThe reveal checks the committed deck; the server still knew all cards.`;
    $("deck-audit").className =
      audit &&
      (!audit.commitmentOk ||
        audit.dealingOk === false ||
        audit.seedOk === false)
        ? "bad"
        : "";
    $<HTMLButtonElement>("btn-audit").disabled = false;
    scene?.handleDeckReveal(reveal.handId);
    pushHistory(
      `Deck audit · ${audit?.detail ?? "missing hand-start observation"}`,
    );
  });
  active.on("YOUR_TURN", renderActions);
  active.on("COMPANION_STATUS", () => {
    const text: Record<string, string> = {
      READY: "Local companion ready",
      OBSERVE_ONLY: "Companion observing · invoice payment disabled",
      PAYMENT_SUBMITTING: "Companion submitting invoice",
      PAYMENT_SUBMITTED: "Companion submitted invoice · awaiting table commit",
      PAYMENT_FAILED:
        "Companion payment submission failed · awaiting table resolution",
    };
    pushHistory(text[active.companionStatus] ?? "Companion status updated");
  });
  active.on("SEAT_STATUS", (msg) =>
    pushHistory(
      `Seat · ${String((msg.payload as { lifecycle: string }).lifecycle)}`,
    ),
  );
  active.on("PAYMENT_REQUIRED", () => {
    paymentFailed = false;
    pushHistory("Fiber payment required · committed chips unchanged");
  });
  active.on("PAYMENT_STATUS", (msg) => {
    const status = String((msg.payload as { status: string }).status);
    paymentFailed = ["FAILED", "CANCELED", "CANCELLED", "EXPIRED"].includes(
      status,
    );
    pushHistory(
      `Payment ${status} · ${paymentFailed ? "no action committed" : "awaiting authoritative commit"}`,
    );
  });
  active.on("ACTION_REJECTED", (msg) => {
    const p = msg.payload as { code: string; detail: string };
    paymentFailed = p.code === "SETTLEMENT_FAILED";
    pushHistory(`Action rejected · ${p.code}: ${p.detail}`);
  });
  active.on("ERROR", (msg) => {
    const detail = String(
      (msg.payload as { detail?: string })?.detail ??
        JSON.stringify(msg.payload),
    );
    pushHistory(`Server error · ${detail}`);
    $("join-status").textContent = detail;
    if (!active.tableState?.seats.some((s) => s.playerId === active.pubkey)) {
      $("screen-connect").classList.remove("hidden");
      $("screen-table").classList.add("hidden");
      $("app").classList.remove("playing");
      $<HTMLButtonElement>("btn-join").disabled = false;
      active.dispose();
    }
  });
  try {
    $("join-status").textContent = "Connecting to the table…";
    await active.connect();
    const snapshot = new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timeout);
        active.off("TABLE_SNAPSHOT", done);
        resolve();
      };
      const timeout = setTimeout(() => {
        active.off("TABLE_SNAPSHOT", done);
        reject(new Error("Table snapshot timeout"));
      }, 10000);
      active.on("TABLE_SNAPSHOT", done);
    });
    await Promise.all([active.authenticate(), snapshot]);
    if (active.tableState?.seats.some((s) => s.playerId === active.pubkey))
      return;
    $("join-status").textContent = "Authenticated · joining the table…";
    await active.join(Number($<HTMLInputElement>("buy-in").value));
  } catch (error) {
    active.dispose();
    $("join-status").textContent = `Unable to join: ${String(error)}`;
    $<HTMLButtonElement>("btn-join").disabled = false;
  }
}

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void start();
});
$("btn-leave").addEventListener("click", () => {
  if (!session) return;
  const local = session.tableState?.seats.find(
    (s) => s.playerId === session!.pubkey,
  );
  const stackCkb = local ? Number(local.stack) / 1e8 : 0;
  try {
    session.leave();
    // Mid-hand leaves are queued by the table and applied between hands.
    $("join-status").textContent = `Cashing out ${stackCkb.toFixed(
      2,
    )} CKB — the payout follows over your channel.`;
    $("screen-connect").classList.remove("hidden");
    $("screen-table").classList.add("hidden");
    $("app").classList.remove("playing");
  } catch (error) {
    pushHistory(`Leave failed · ${String(error)}`);
  }
});
$("btn-topup").addEventListener("click", () => {
  if (!session) return;
  const amount = Number($<HTMLInputElement>("top-up").value);
  if (!(amount > 0)) {
    pushHistory("Top-up: enter a positive CKB amount");
    return;
  }
  try {
    session.topUp(amount);
    pushHistory(`Top-up requested · ${amount} CKB`);
  } catch (error) {
    pushHistory(`Top-up failed · ${String(error)}`);
  }
});
$("btn-fold").addEventListener("click", () => void submit("FOLD"));
$("btn-check").addEventListener("click", () => void submit("CHECK"));
$("btn-call").addEventListener("click", () => void submit("CALL"));
$("btn-all-in").addEventListener("click", () => void submit("ALL_IN"));
$("btn-raise").addEventListener("click", () => {
  const turn = session?.yourTurn;
  const type = wagerAction(turn ?? null);
  if (turn && type)
    void submit(
      type,
      sliderAmount(turn, Number($<HTMLInputElement>("raise-slider").value)),
    );
});
$("raise-slider").addEventListener("input", renderAmount);
$("btn-min").addEventListener("click", () => {
  $<HTMLInputElement>("raise-slider").value = "0";
  renderAmount();
});
$("btn-camera").addEventListener("click", () => scene?.resetCamera());
$("btn-details").addEventListener("click", () =>
  $<HTMLDialogElement>("journal").showModal(),
);
$("btn-close-details").addEventListener("click", () =>
  $<HTMLDialogElement>("journal").close(),
);
$("btn-audit").addEventListener("click", () => {
  if (lastRevealId) session?.requestDeckAudit(lastRevealId);
});
setInterval(() => {
  if (!document.hidden) renderClock();
}, 250);
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    scene?.dispose();
    session?.dispose();
  }
});

$("agent-identity").addEventListener("change", async () => {
  const file = $<HTMLInputElement>("agent-identity").files?.[0];
  const request = ++identityRead;
  agentIdentity = undefined;
  $<HTMLButtonElement>("btn-join").disabled = true;
  try {
    if (!file || file.size > 2048)
      throw new Error(
        "Choose the agent's .session.json poker identity file (under 2 KB).",
      );
    const selected = parseAgentIdentity(await file.text());
    if (request !== identityRead) return;
    agentIdentity = selected;
    $<HTMLButtonElement>("btn-join").disabled = false;
    $("identity-status").textContent =
      `Companion identity ${short(agentIdentity.publicKey)} · kept only in this tab`;
    $<HTMLInputElement>("ws-url").value = "ws://127.0.0.1:8788";
  } catch (error) {
    if (request === identityRead)
      $("identity-status").textContent = String(error);
  }
});
// On-ramp: ask the loopback companion for the identity IT generated this
// run (--generate-identity). The companion only ever serves an identity it
// created; operator-provided files are never exposed over the wire.
$("btn-generate-identity").addEventListener("click", () => {
  const url =
    $<HTMLInputElement>("ws-url").value.trim() || "ws://127.0.0.1:8788";
  $<HTMLInputElement>("ws-url").value = url;
  const request = ++identityRead;
  $("identity-status").textContent = "Requesting identity from the companion…";
  let ws: WebSocket | null = new WebSocket(url);
  const finish = (status: string, identity?: { privateKey: string; publicKey: string }) => {
    if (request !== identityRead) return;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    ws = null;
    $("identity-status").textContent = status;
    if (identity) {
      agentIdentity = parseAgentIdentity(JSON.stringify(identity));
      $<HTMLButtonElement>("btn-join").disabled = false;
      $("identity-status").textContent = `Companion-generated identity ${short(
        agentIdentity.publicKey,
      )} · kept only in this tab`;
    }
  };
  const timer = setTimeout(() => finish("Companion did not answer (is it running with --generate-identity?)."), 8000);
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data)) as { type: string; payload: Record<string, unknown> };
      if (m.type === "IDENTITY" && m.payload.privateKey && m.payload.publicKey) {
        clearTimeout(timer);
        finish("", {
          privateKey: String(m.payload.privateKey),
          publicKey: String(m.payload.publicKey),
        });
      } else if (m.type === "ERROR") {
        clearTimeout(timer);
        finish(String((m.payload as { detail?: string }).detail ?? "companion refused"));
      }
    } catch {
      /* non-JSON frame: ignore */
    }
  };
  ws.onerror = () => {
    clearTimeout(timer);
    finish("Companion unreachable — start it and try again.");
  };
  ws.onopen = () => {
    ws?.send(JSON.stringify({ type: "IDENTITY_REQUEST", payload: {} }));
  };
});
$("btn-clear-identity").addEventListener("click", () => {
  identityRead++;
  agentIdentity = undefined;
  $<HTMLInputElement>("agent-identity").value = "";
  $<HTMLButtonElement>("btn-join").disabled = false;
  $("identity-status").textContent = "Using this browser’s saved identity.";
});
