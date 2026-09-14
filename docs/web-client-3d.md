# Three.js browser frontend

The frontend is a view of the authoritative demo. It does not own poker state,
turn rules, balances, signing keys, or Fiber RPC credentials.

```
WebSocket → PokerSession → PublicTableState → stateAdapter → TableScene
                    ↘ targeted hole cards / turn / payment status
DOM controls → advertised legal action → PokerSession.act → signed ACTION
```

`main.ts` binds events and maintains the DOM action dock, status indicators and
mobile journal. `session.ts` continues to authenticate, sign actions, verify
public-state chain hashes, acknowledge commits and reconnect/resync. Its pending
action guard rejects duplicate submissions; BET and RAISE use the exact advertised
verb and integer “to” range. No rules are recalculated by the view.

`table3d/TableScene.ts` owns the renderer, camera, six persistent card/seat/stack
groups, projected HTML labels and lifecycle cleanup. `stateAdapter.ts` contains
only display conversions and backend-seat-to-visual-slot mapping. Local seat maps
to foreground slot zero without modifying backend seat numbers. `CardRenderer`
caches canvas face/back textures and shared dimensional geometry; `ChipRenderer`
uses capped instanced decorative stacks. Exact CKB amounts remain in HTML, never
in chip counts. `TableGeometry` creates the felt, padded rail, trim and lighting
surface without external assets. `animations.ts` bounds cosmetic transitions;
each newer committed sequence finishes stale transitions before applying its view.

| Authoritative input | Visual response |
| --- | --- |
| Snapshot/resync | Snap to the observed state, without replaying economic animations |
| New dealt-in hole commitments | Deal cards from shoe to occupied seats |
| Targeted HOLE_CARDS | Update only the local hand, scoped to the current hand ID |
| New board cards in a commit | Sequential arrivals and flips for flop, turn, river |
| Increased street contribution | Move decorative chips to that seat's committed bet area |
| Cleared street contributions | Consolidate chips toward the central pot |
| Fold / all-in commit | Muck slide / brief seat emphasis |
| Button seat changes | Glide dealer marker to the new visual position |
| Acting seat | Seat border/rail halo; targeted deadline adds seconds and countdown |
| PAYMENT_REQUIRED | Local seat-to-settlement pulse, pending copy, locked controls |
| Failed/cancelled payment | Stop the pulse, show failure; committed chips stay unchanged |
| Payment success | Remain pending until authoritative commit; success alone moves no chips |
| HAND_RESULT | Show server-provided showdown cards and announce awards as pending |
| SETTLEMENT → HAND_COMPLETE commit | Animate previously announced pot awards toward winners, including split/side-pot awards |
| DECK_REVEALED | Audit the observed commitment, dealt-in hole hashes and observed board in the journal |

## Backend details discovered during integration

- Cards on the current wire are numeric 0–51, including targeted and showdown
  cards. Display conversion also accepts the string representation.
- START_HAND precedes its STATE_COMMIT and has no hole-card hashes yet. The audit
  retains that observation, then captures the first post-blind deal commit with
  actual hole commitments. It never reconstructs private opponent faces to render.
- Pots/side pots are materialized at SETTLEMENT. Before then the display totals
  committed hand contributions. It never adds those contributions to existing pots.
- HAND_RESULT precedes payout settlement. DISTRIBUTE_POTS resets hand ID, board,
  pots and awards; the completion animation uses the immediately preceding
  settlement awards only after the same hand number commits HAND_COMPLETE.
- YOUR_TURN is targeted. The backend does not currently broadcast opponents'
  deadlines, so opponents receive an acting halo without a fabricated countdown.
- RESYNC supplies public state and seat metadata, but does not replay the current
  YOUR_TURN or HOLE_CARDS. In-place reconnect retains same-hand cards already held;
  a page reload waits for fresh private cards/turn messages. Controls do not invent
  a legal action or new deadline. A snapshot establishes a chain baseline, not
  verification of unseen history. The existing browser chain check verifies hash
  links/recomputation; this change does not add table-signature verification.
- Remote channel readiness and physical topology are not broadcast. Remote seat
  dots are neutral/unreported; no peer-to-peer mesh or independent channels are
  invented. Channels can be shared behind a Fiber node.
- The server advertises fake settlement and auto-pay, but does not distinguish
  immediate versus experimental hold settlement in WELCOME. The UI therefore says
  “awaiting committed state”; it does not claim a held invoice is final settlement.
- No protocol, poker engine, server or settlement changes are required by this UI.

## Mobile rendering and accessibility

Fixed orthographic oblique framing keeps far-edge cards legible. Drag allows only
small yaw/elevation changes; pinch zoom is tightly bounded; double tap or Reset
view restores framing. Gestures bind only to canvas, not DOM controls. ResizeObserver
updates drawing size, projection and seat HUD positions after viewport/orientation
changes. The dock and journal respect safe-area insets. The modal journal provides
keyboard focus containment and Escape dismissal, exact amounts, board/private-card
text, side pots, awards, connection details, audit and 60 recent events.

Pixel ratio is capped at 1.5 and the drawing buffer at 1.6 million pixels,
with one 1024px shadow map updated only when geometry changes, shared low-poly geometry,
cached textures, bounded 24-instance chip stacks and no postprocessing. Rendering
pauses while hidden; timer DOM updates run at 5Hz; reduced-motion preferences complete transitions immediately.
WebGL failure retains DOM controls and a readable live-table journal.

## Run and verify

From the repository root:

```sh
npm install
FIBER_POKER_DATA_DIR=.data/demo FIBER_POKER_PORT=8080 npm run server
npm run dev -w @fiber-poker/web-client
npm run typecheck
npm run typecheck -w @fiber-poker/web-client
npm run build -w @fiber-poker/web-client
npm test
npm run demo:two
npm run demo:six
npx playwright install chromium
npm run test:browser -w @fiber-poker/web-client
```

Browser tests start isolated in-memory authoritative servers using the repository's
existing fake adapter and TestClient bots. Screenshots are written to ignored
`apps/web-client/test-results/` at 390px portrait, 844px landscape and desktop;
360px layout is also checked. Fault injection is test-only. Unit regressions cover
exact BET/RAISE verbs, integer amount bounds, six-seat mapping, payout gating,
partial/complete deck audits, payment success/failure, stale private cards and
broken chain hashes. Engine/integration suites cover split and side pots, timeouts,
settlement faults and lifecycle changes. A dedicated browser case verifies an actual timeout and in-place WebSocket
reconnect. Live Fiber tests remain environment-gated.
Physical Android/iOS GPU performance requires device measurement; software Chromium
screenshots are not a claim of measured 60fps on phones.

Trust wording remains **authoritative but auditable**, with the persistent
**DEVNET/TESTNET PLAY VALUE ONLY** banner and conspicuous fake-settlement indicator.

## Optional local Fiber companion (P3)

The browser can now select the agent's poker identity and connect through a local
companion, keeping one authenticated table connection and leaving all FNN
credentials/payment execution in the node process. See
[browser companion runbook](browser-companion.md) for setup, origin restrictions,
explicit invoice-payment opt-in and simulated verification. This does not change
the renderer or the authoritative state/settlement boundary described above.
