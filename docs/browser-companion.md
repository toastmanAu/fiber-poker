# Browser + local Fiber companion

This implements HANDOFF P3 without changing the authoritative server or creating a
second connection for the same player. `SessionManager.register` replaces an old
connection for a player; a browser and the headless agent cannot independently
connect using the same key and both expect targeted payment/turn messages.

Instead, run **one companion process instead of the headless playing agent**:

```
Three.js / DOM ← PokerSession ← local companion ← authoritative table
DOM action → PokerSession signed envelope → local companion → table
                                              ↓
                                         player's FNN
```

The browser chooses poker actions and signs with the selected poker identity.
The companion forwards the envelopes unchanged, declares its actual Fiber node
pubkey on JOIN_TABLE and, when explicitly enabled, pays table-requested invoices.
The table still verifies signatures, applies rules, coordinates settlement and
commits state. The companion never synthesizes STATE_COMMIT, YOUR_TURN, balances,
awards, payment success, or settlement results.

## Run locally

Use the existing table/node setup from HANDOFF. On the laptop that runs the
browser, configure the companion using the player's node credentials in environment
variables (not web form fields). No tokens are stored in the web application.

```sh
# Required existing configuration:
# FIBER_POKER_TABLE_URL=ws://<table-host>:8080
# FIBER_POKER_FNN_URL=http://<player-node>:8231
# FIBER_POKER_FNN_TOKEN=<player-node token, held in this process environment>

npm run companion -w @fiber-poker/player-agent -- \
  --key-file /path/to/alice.session.json --pay-invoices

# Separate terminal:
npm run dev -w @fiber-poker/web-client
```

The key file is the existing player's poker `.session.json` produced by the agent,
containing only `privateKey` and `publicKey`. It is **not** a Fiber node key, token,
node configuration or table signing key. Stop the headless playing agent before
using the companion for that identity.

Open the local frontend. Expand **Play with a local Fiber companion**, choose the
matching poker identity file and connect to `ws://127.0.0.1:8788`. The selected key
is validated, kept only in the tab, and never overwrites the browser's saved demo
identity. A reload requires choosing it again. **Use browser identity** restores
the existing demo identity choice. Invalid files disable joining until corrected.

The companion defaults to **observe-only**; `--pay-invoices` is the local
operator's explicit opt-in to automatic payment of the configured table's invoice
requests, including buy-ins and bets. Without it, requests remain pending until
another payer handles them or the table's timeout/failure policy resolves them.
This remains **DEVNET/TESTNET PLAY VALUE ONLY**.

## New-player on-ramp

Run the companion with:

```sh
npm run companion -w @fiber-poker/player-agent --   --generate-identity --ensure-capacity-ckb 60 --pay-invoices
```

- `--generate-identity` creates (or reuses) the player's poker identity and
  serves it to the loopback browser on request: the web client's
  "New player? Generate identity via companion" button asks for it over the
  local socket. Operator-provided identity files are never served this way.
- `--ensure-capacity-ckb N` makes the companion provision player-side
  channel capacity toward the table after WELCOME, so the new player can
  actually pay (rc7 has no post-open funding). The table auto-provisions
  its own payout side at join (FIBER_POKER_AUTO_CAPACITY).

The UI then needs no identity file: "New player? Generate identity via
companion" populates the tab, and Take a seat joins with the generated key.

## Shared funding node (multiple players, one companion)

One funded fnn node can back several players: run the companion with
`--generate-identity --players N`. It serves N poker identities — each
browser connection claims one via the "New player" button (round-robin,
first come first served; a second tab for the SAME identity is refused,
since it would replace the player's table session). Every invoice the
companion pays is recorded in a per-player spend ledger
(`relay.exportLedger()`): playerId, obligationId, reason, amount, time.

Operator settlement for cash-outs: payouts are keysends TO the shared node
and are attributed by joining the obligationIds in this ledger against the
table's event log (every payout obligation carries the player id). Trust
note (docs/15, unchanged): the funding node can always see payment flow;
the ledger makes it accountable, not trustworthy.

Options: `--port 8788`, `--web-origin http://localhost:5173`, `--name alice`,
`--key-dir .data/agents`, `--key-file <exact path>`, `--table <URL>`,
`--generate-identity`, `--players <N>` (with --generate-identity), and
`--ensure-capacity-ckb <N>`.
Default allowed origins are `http://localhost:5173` and `http://127.0.0.1:5173`.
The listener binds only `127.0.0.1`, checks Origin and the selected player identity,
and accepts one browser connection at a time. It has no HTTP endpoint to read
keys or credentials. A phone cannot connect to the laptop's loopback listener;
remote companion transport is outside this change.

## Payment status and reconnect

The existing PAYMENT_REQUIRED/PAYMENT_STATUS messages are forwarded intact. Local
COMPANION_STATUS messages are transport-side observations only (never sent to the
table): READY, OBSERVE_ONLY, PAYMENT_SUBMITTING, PAYMENT_SUBMITTED, PAYMENT_FAILED.
Submission returning is not authoritative economic success, especially with hold
invoices. Neither local submission nor local failure changes chips or unlocks a
pending action. The UI waits for the table's commit or rejection/failure policy.
Completed invoice requests are deduplicated; failed submissions can retry if the
table requests them again.

Closing the tab drops the upstream connection. Reconnecting authenticates the same
identity through a new single upstream connection, and existing PokerSession resync
restores the public state. Current backend limits still apply: no replay of a missed
current YOUR_TURN/private-card message. Stopping the companion does not cash out or
claim to cancel an invoice already submitted; normal table lifecycle/timeout rules
still govern the seat.

## Verification

```sh
npx vitest run tests/integration/companion.test.ts \
  tests/protocol/agent-identity.test.ts tests/protocol/web-client.test.ts
npm run test:browser -w @fiber-poker/web-client -- companion.spec.ts
npm run typecheck -w @fiber-poker/web-client
npm run typecheck
npm run build -w @fiber-poker/web-client
npm test
```

All new payment tests use `SimulatedFiberNetwork`, generated test-only identities,
an in-memory authoritative table, and the existing ImmediateFiberSettlement
adapter. The browser test imports the agent-format identity, pays simulated
buy-in/blinds, signs a legal raise, holds the simulated invoice submission, asserts
unchanged committed stack/sequence while pending, then observes the committed
transition. Transport tests cover origins, wrong identities, default no-payment
behavior, invoice deduplication and unchanged action contents. **This integration
has not been run against live FNN nodes; no node credentials or live funds were
used while implementing it.**
