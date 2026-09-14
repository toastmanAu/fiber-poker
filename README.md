# Fiber Poker — implementation

Single-table 2–6 player No-Limit Texas Hold'em over Nervos Fiber Network
channels. **Devnet/testnet and non-redeemable play value only** — this build
contains no real-money release path.

> **Trust model: authoritative but auditable — NOT trustless.** The table
> server deals the cards, orders actions, and decides settlements. It is
> auditable through a deterministic engine, a signed hash chain, and deck
> commitment/reveal. Do not describe this system as trustless or provably
> fair dealing.

## Quickstart (dev, fake settlement)

```bash
# 1. run the table server (fake settlement: no Fiber node needed)
npm install
FIBER_POKER_DATA_DIR=.data/demo FIBER_POKER_PORT=8080 npm run server

# 2. open the mobile-first web client (another terminal)
npm run dev -w @fiber-poker/web-client     # http://localhost:5173
#    enter ws://127.0.0.1:8080, pick a buy-in, join.
#    DEV MODE auto-approves payments — surfaced in the UI.

# 3. or run scripted demos
npm run demo:two        # two-player table on :8090
npm run demo:six        # six-player table on :8091 (side pots, leave/join)

# 4. run the whole test suite
npm test
```

## Three.js table frontend

The browser client now renders a procedural six-seat 3D table with a mobile action
dock, local-seat camera mapping, payment-before-commit effects, and an audit/history
journal. No external models or Fiber credentials are needed in the browser.
See [frontend architecture and verification](docs/web-client-3d.md) for scene
modules, event mapping, browser test commands and current protocol limitations.

For browser-controlled play with the player's Fiber node, use the
[local companion runbook](docs/browser-companion.md). The browser imports only the
poker identity; the companion keeps node credentials and invoice execution local.

## Configuration (env)

| Variable | Default | Meaning |
| --- | --- | --- |
| `FIBER_POKER_PORT` | `8080` | WebSocket port |
| `FIBER_POKER_HOST` | `127.0.0.1` | Bind address |
| `FIBER_POKER_DATA_DIR` | `.data/table` | Server key + event log + snapshots |
| `FIBER_POKER_SETTLEMENT` | `fake` | `fake` (dev/CI), `fiber` (immediate FNN), or `hold` (experimental hold invoices, P9) |
| `FIBER_POKER_SETTLEMENT_TIMEOUT_MS` | `120000` | Max wait for one obligation to reach commit-able status |
| `FIBER_POKER_DECK` | `server-commit-reveal` | `multiparty-seed` enables the P10 seed protocol |
| `FIBER_POKER_SEED_TIMEOUT_MS` | `2000` | Per-phase deadline for the seed protocol |
| `FIBER_POKER_FNN_URL` | – | FNN RPC URL when settlement=fiber |
| `FIBER_POKER_FNN_TOKEN` | – | FNN auth token (server-side only!) |
| `FIBER_POKER_TURN_TIMEOUT_MS` | `30000` | Turn timer; expiry = check if legal else fold |
| `FIBER_POKER_SMALL_BLIND` / `FIBER_POKER_BIG_BLIND` | 1 CKB / 2 CKB | Blinds in shannons |
| `FIBER_POKER_CHANNEL_FUNDING` | 1000 CKB | Table-side channel funding per seat |
| `FIBER_POKER_AUTO_PAY` | `true` | Fake-settlement auto-approval (DEV ONLY) |
| `FIBER_POKER_AUTO_START_HANDS` | `true` | Deal when ≥2 eligible players |

## Repository layout

```
apps/
  table-server/   authoritative coordinator (payment-before-commit)
  web-client/     mobile-first browser client (Vite, no framework)
packages/
  poker-engine/   PURE deterministic NLHE engine (no IO/clock/RNG/floats)
  protocol/       canonical encoding, BLAKE2b hashing, secp256k1 signatures
  deck/           V0 server commit/reveal deck (+ V1/V2 stubs)
  persistence/    append-only event store + snapshots
  settlement/     SettlementAdapter: fake (fault injection), immediate-fiber,
                  hold-invoice experiment, state-channel stub
  fiber-adapter/  narrow FNN v0.9.0 gateway + simulated fiber network
tests/
  engine/         property/fuzz tests (fast-check)
  protocol/       envelope/replay/state-chain tests + security tests
  fiber/          simulated network + liquidity manager tests
  integration/    2-player and 6-player scripted end-to-end suites + demos
  chaos/          settlement fault matrix, crash/restart recovery
docs/             protocol spec, threat model, FNN compatibility note
infra/            devnet / FNN / watchtower configuration templates
```

## Settlement modes

- **fake** (default): in-memory settlement with fault injection. Dev/CI only; the UI labels it.
- **fiber**: immediate settlement — every obligation fully settles before its action commits.
- **hold** (experimental, P9): the table creates a *hold invoice* bound to `H(preimage)`; the player pays it, the funds **lock** (invoice `Received`) without becoming final, and only then does the action commit. At hand end the table settles every held invoice; on abort it cancels them and the funds return to the players **by protocol** — refunds stop depending on table goodwill. Limits: the hold condition is still payment-hash/preimage; it does not evaluate poker or create six-party escrow. Payouts remain immediate. See `docs/threat-model.md` and `docs/fnn-compat.md` (verify `settle_invoice`/`cancel_invoice` against your pinned FNN build).

## The one rule that matters

**Economic state never outruns Fiber state.** Every value-changing action
goes through:

```
ACTION_PROPOSED -> RULE_VALIDATED -> PAYMENT_PLANNED -> FIBER_INFLIGHT
                 -> FIBER_SUCCESS -> ACTION_COMMITTED
```

A failed payment NEVER commits the poker transition. See
`packages/settlement` and `apps/table-server/src/coordinator.ts`. Chaos
tests in `tests/chaos/` kill the server at every durable boundary and
verify exactly-once settlement.

## Player agent (docs/15)

A headless player with its own Fiber credentials — the bridge between the
browser UI and real money:

```bash
FIBER_POKER_TABLE_URL=ws://127.0.0.1:8080 \
FIBER_POKER_AGENT_NAME=alice \
FIBER_POKER_FNN_URL=http://<player-node>:8231 \
FIBER_POKER_FNN_TOKEN=<player biscuit> \
FIBER_POKER_BUY_IN_CKB=10 \
npm run agent -w @fiber-poker/player-agent
```

The agent authenticates with its persisted session key, DECLARES its Fiber
node pubkey on `JOIN_TABLE` (docs/15: session key ≠ node key; a false
declaration can only misdirect the declarer's own payouts), auto-pays every
`PAYMENT_REQUIRED` invoice from its node, plays a simple policy
(`--policy call-station|tight`), and leaves cleanly on SIGINT.

## Live Fiber node testing (gated)

With a testnet FNN node reachable, the read-only live suite validates the
adapter surface against reality (shapes, enums, auth, invoice lifecycle —
no funds moved):

```bash
FIBER_POKER_FNN_URL=http://<node>:8227 \
FIBER_POKER_FNN_TOKEN=<base64 biscuit token> \
npx vitest run tests/fiber/live-node.test.ts
```

And the **full 2-agent hand with real settlements** (table node + player
node; two headless agents declare the player node and self-pay):

```bash
FIBER_POKER_FNN_URL=http://<table>:8227 FIBER_POKER_FNN_TOKEN=<table biscuit> \
FIBER_POKER_PLAYER_FNN_URL=http://<player>:8231 FIBER_POKER_PLAYER_FNN_TOKEN=<player biscuit> \
npx vitest run tests/fiber/live-agent-hand.test.ts
```

VERIFIED LIVE 2026-09-10/11 against `fnn 0.9.0-rc7`: five real invoice
payments (buy-ins, blinds, bets) settled payment-before-commit by two
self-driving agents, plus the payout leg. Channel-opening rules learned the
hard way: always pass `funding_fee_rate: 20000` (fnn's default 1000
underpays cycle-heavy funding txs and they die after broadcast), never open
under 100 CKB (peers' auto-accept floor silently pins sub-floor opens
forever), and a poker player's fiber node key differs from their poker
session key (`FIBER_POKER_PEER_MAP` / declared peers).

VERIFIED LIVE 2026-09-10/11 against `fnn 0.9.0-rc7`: five real invoice
payments (buy-ins, blinds, bets) settled payment-before-commit, and the
payout leg. Channel-opening rules learned the hard way: always pass
`funding_fee_rate: 20000` (fnn's default 1000 underpays cycle-heavy funding
txs and they die after broadcast), never open under 100 CKB (peers'
auto-accept floor silently pins sub-floor opens forever), and a poker
player's fiber node key differs from their poker session key
(`FIBER_POKER_PEER_MAP`).

Without the env vars the suite skips. Channel open/close and payment tests
move testnet funds and require `FIBER_POKER_LIVE_CHANNELS=1` plus
`FIBER_POKER_LIVE_PEER` (peer multiaddr). RPC auth uses FNN Biscuit tokens
(`Authorization: Bearer <base64>`) — server-side only, never in browsers.

## Documentation

- `docs/protocol.md` — wire format, canonical encoding, hash chain, auth
- `docs/threat-model.md` — what the table can and cannot do to you
- `docs/fnn-compat.md` — verified FNN v0.9.0 RPC compatibility note
- `docs/deployment.md` — devnet deployment guide (CKB devnet + FNN + watchtower)
- `docs/mental-poker-research.md` — P11 research prototype + path to production
- `docs/poker-channel-research.md` — P12 generalized CKB poker channel research
- `../fiber-poker-agent-handoff/` — the original specification handoff

## Release gate

Devnet/testnet only. Real-money poker triggers gambling regulation
(licensing, geofencing, KYC/AML; notably ACMA treats online poker offered
to Australian customers as a prohibited interactive gambling service).
Obtain jurisdiction-specific legal advice before any real-value deployment
and keep those gates outside the protocol.

## License

MIT — see [LICENSE](LICENSE). Note the release gate above: this project
targets devnet/testnet and non-redeemable play value only; licensing does not
address real-money gambling regulation, which remains gated per
[docs/11-legal-release-gates in the project handoff](https://github.com/toastmanAu/fiber-poker#release-gate).
