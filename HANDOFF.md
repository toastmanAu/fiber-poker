# Session Handoff — Fiber Poker

**Last updated:** 2026-09-14
**Repo:** https://github.com/toastmanAu/fiber-poker (branch `master`)
**Working copy on the laptop:** `~/fiber-poker/fiber-poker`
**Original spec handoff:** `~/fiber-poker/fiber-poker-agent-handoff/`

This file is the resume point for the next session. It records exactly where
the project stands, how to reach the live test environment, and what remains.

---

## 1. Project status — all roadmap milestones have working code

| Milestone | State |
|---|---|
| P0–P8 (engine → web client) | ✅ production code, 108 unit/integration tests green |
| P9 hold-invoice experiment | ✅ implemented, live-verified primitives |
| P10 multiparty seed commit/reveal | ✅ implemented + e2e tests |
| P11 mental poker | ✅ research prototype + `docs/mental-poker-research.md` |
| P12 generalized CKB poker channel | ✅ simulator + `docs/poker-channel-research.md` |
| **Live testnet validation** | ✅ real money moved on `fnn 0.9.0-rc7` (details §3) |
| **Player agent** | ✅ `apps/player-agent`, live-verified (details §3) |
| **Multi-hand live session** | ✅ top-up + dual cash-out live (details §3.6) |
| **Six-agent live demo** | ✅ full table behind one player node, live (details §3.7) |
| **Hold-mode live session** | ✅ hold-at-bet → settle-at-hand-end on rc7 (details §3.8) |
| **Watchtower live validation** | ✅ built-in tower + force-close lifecycle on real nodes (§3.9) |
| **Multiparty-seed live run** | ✅ P10 commit/reveal deal with real settlements (§3.10) |

Suite: **128 pass + 14 gated-skip (vitest; live tests run only with env
vars)** plus the Playwright browser specs (sim + live companion specs).
Typecheck clean. Committed and pushed through the P3 polish + live
validations (watchtower, multiparty-seed).

Run everything from `~/fiber-poker/fiber-poker`:

```bash
npm install          # workspaces; Node >= 22
npm test             # full suite (live tests skip without env)
npm run demo:two     # scripted 2-player demo (fake settlement)
npm run demo:six     # scripted 6-player demo
npm run server       # table server (fake settlement by default)
```

---

## 2. Live test environment

Two real `fnn 0.9.0-rc7` testnet nodes on the LAN, both Biscuit-authenticated
(`Authorization: Bearer <base64>`):

| Role | Node | RPC | Pubkey |
|---|---|---|---|
| **Table** | Pi (`192.168.68.80`) | `:8227` | `024508b9ab7d…` |
| **Player** | driveThree (`192.168.68.102`) | `:8231` | `03228fd9db…` |

**Tokens are NOT stored on the laptop** (deliberate). Retrieve per run:

```bash
TTOK=$(ssh phill@192.168.68.80 'cat ~/.fiber-testnet/.secrets/biscuit-token.txt')
DTOK=$(tr -d '[:space:]' < ~/Downloads/biscuit-token.txt)   # driveThree token (30d, minted 2026-09-10)
```

This laptop's SSH key (`fiber-poker-build-agent`) is authorized on both
nodes. Runbook with full detail: `~/fiber-poker/fiber-pi-biscuit-token.md`.

**Gated live suites** (skip without env):

```bash
# read-only + invoice lifecycle (no funds moved):
FIBER_POKER_FNN_URL=http://192.168.68.80:8227 FIBER_POKER_FNN_TOKEN=$TTOK \
  npx vitest run tests/fiber/live-node.test.ts

# full 2-player hand, real settlements (~5 payments, <10 CKB total):
FIBER_POKER_FNN_URL=http://192.168.68.80:8227 FIBER_POKER_FNN_TOKEN=$TTOK \
FIBER_POKER_PLAYER_FNN_URL=http://192.168.68.102:8231 FIBER_POKER_PLAYER_FNN_TOKEN=$DTOK \
  npx vitest run tests/fiber/live-agent-hand.test.ts

# full multi-hand SESSION (3 hands + 5 CKB top-up + dual cash-out +
# cooperative channel close, ~25 CKB total):
FIBER_POKER_FNN_URL=http://192.168.68.80:8227 FIBER_POKER_FNN_TOKEN=$TTOK \
FIBER_POKER_PLAYER_FNN_URL=http://192.168.68.102:8231 FIBER_POKER_PLAYER_FNN_TOKEN=$DTOK \
  npx vitest run tests/fiber/live-multihand.test.ts
```

Channel state (2026-09-11, after the multi-hand session): **2 ChannelReady
channels** between the nodes (`0xa118…` table 0 / player 51 CKB,
`0xa133…` table 168 / player 233 CKB). The multi-hand session used and
cooperatively CLOSED a third channel (its final tx is on-chain). fnn routes
keysend payments over ANY channel to the peer with capacity — the session's
"own" channel is only a mapping/bookkeeping handle. Both wallets also hold
on-chain change (table ~194k CKB, driveThree ~100k). Stale ghost channels in
`list_channels {only_pending:true}` are cosmetic residue of sub-floor opens
— no funds.

---

## 3. What was verified live (do not re-litigate)

All recorded in `docs/fnn-compat.md` ("VERIFIED AGAINST A LIVE NODE"):

1. **rc7 shape corrections** (adapter already fixed): `node_info.pubkey`
   (not node_pubkey), nested channel state `{state:{state_name}}`, channel
   peer field is `pubkey`, `new_invoice` REQUIRES `currency` ("Fibt" on
   testnet), `open_channel` requires BOTH `peer_id` AND `pubkey`.
2. **CRITICAL invoice semantics**: a `new_invoice` with only `payment_hash`
   can NEVER be settled (payee lacks the preimage; sits at `Received` until
   cancelled). The payee-side flow is `payment_preimage`-only creation →
   fnn auto-settles on TLC arrival (immediate) or waits for
   `settle_invoice` (hold). `ImmediateFiberSettlement` is built on this.
   Correlation with the poker transcript travels via obligationId in the
   event log (deterministic payment-hash derivation is unimplementable).
3. **Verified live money flows**: player→table invoice paid (1 CKB,
   TLC → Received → Paid, balances moved both sides); cancel/refund path
   (cancel_invoice → payer Failed/InvoiceCancelled → TLC refunded);
   insufficient-liquidity rejection; full 2-player hand (5 real payments:
   2 buy-ins, blinds, bet — payment-before-commit enforced at every step,
   conservation held); two table→player payouts (keysend, from the other
   agent's session).
4. **Channel opening rules** (hard-won):
   - ALWAYS pass `funding_fee_rate: 20000` — fnn's default 1000 underpays
     cycle-heavy funding txs and they are rejected AFTER broadcast,
     destroying the channel (`PoolRejectedTransactionByMinFeeRate`).
   - Never open under 100 CKB: below the peer's auto-accept floor the open
     is pinned in `NegotiatingFunding` FOREVER with no rejection (fnn logs
     nothing; cleanup = `abandon_channel`). Under the 99 CKB initiator
     reserve the channel is useless anyway. Gateway enforces the floor.
   - `NegotiatingFunding` flag display gotcha: `OUR_INIT_SENT|INIT_SENT`
     renders for stored value 1 (our open only) — count the names (3 = both
     inits) or check `is_acceptor`.
   - The shared public CKB RPC (`testnet.ckbapp.dev`) is healthy (0.17s) —
     was never the issue.
5. **Biscuit auth**: per-node roots (a token minted for one node can never
   auth against the other — bare `Unauthorized`, no hint). Auth middleware
   runs after JSON parse (parse error `-32700` precedes `-32999`).
6. **CRITICAL keysend semantics (2026-09-11)**: `send_payment` REJECTS
   `keysend: true` + `payment_hash` (`InvalidParameter: "keysend payment
   should not have payment_hash"`). Payouts keysend WITHOUT a hash and poll
   the RESPONSE `payment_hash`; transcript correlation travels via
   obligationId in the event log. Before the fix, every payout THREW inside
   `settleHand`, which stranded the phase in `SETTLEMENT` and silently
   froze the table (no `DISTRIBUTE_POTS`, no hand 2, no queue drains).
   `SettlementCoordinator.fulfilOne` now converts adapter throws into
   recorded failed attempts (coherent fail-stop). Full write-up:
   `docs/fnn-compat.md` → "Keysend payout finding".
7. **Multi-hand live session verified** (2026-09-11, don't re-prove):
   3 chained hands, mid-session TOP_UP (queued mid-hand, applied between
   hands), dual cash-out — seat-by-seat payouts then ONE cooperative
   shutdown for the shared channel. LAN nodes are FAST: a full 3-hand
   session with 15 real invoices settles in ~7s; `list_channels` order is
   not stable, so never assume "first ready channel" is stable across
   calls.
8. **Six-agent live demo verified** (2026-09-11): six agents on one
   shared channel (refcount 6), 2 hands, all cashed out, one cooperative
   close — 39s live (`tests/fiber/live-sixagent.test.ts`). It exposed a
   real server bug: queued joins colliding on one seat number (fixed:
   seats re-checked at seat-time with a free-seat fallback).
9. **Hold-mode live session verified** (2026-09-11): TRUE rc7 holds
   (payment_hash-only invoices, hash = ckb-blake2b of the table's
   preimage) park at `Received`; bets commit on HELD;
   `settle_invoice` at hand end (async Paid ~3-9s — `finalize` waits for
   Paid before payouts); buy-ins/top-ups finalize immediately (never
   registered as hand-held). Two simulator-invisible bugs fixed:
   PaymentRequest must carry `invoiceAddress` (the agent pays the
   ADDRESS), and hold payouts must use `resolvePeer` — paying the raw
   session key gives `PathFind error: no path found`. Full recipe:
   `docs/fnn-compat.md` → "Hold-mode live session findings".

---

## 4. Remaining work (prioritized)

### P1 — finish the live 2-player table story — ✅ ALL DONE (2026-09-11)
- [x] **Multi-hand session on live nodes** (commit 15dad8e):
      `tests/fiber/live-multihand.test.ts` — THREE chained hands, losing
      seat tops up 5 CKB between hands, both seats cash out. Passed live.
      Exposed + fixed the rc7 keysend payout bug (§3.6) and the
      shared-channel close race (ChannelManager refcounts; close fires on
      the last seat only).
- [x] **6-agent live demo** (commit this session):
      `tests/fiber/live-sixagent.test.ts` — six agents, one shared
      channel, 2 hands, all cashed out, one close. Passed live in 39s.
      Caught + fixed the queued-join seat-collision bug in
      `processMembershipQueues`. Rehearsal: `tests/fiber/six-agent-session.test.ts`.
      Side pots/odd chips remain covered by engine unit tests (call-station
      agents don't raise, so live all-in side pots don't arise naturally).
- [x] **Hold-mode live test** (commit this session):
      `tests/fiber/live-hold.test.ts` — TRUE rc7 holds end to end: bets
      commit on HELD (`Received`), `settle_invoice` at hand end, keysend
      payouts, cash-out + close. Passed live in 8.5s. Recipe + the two
      simulator-invisible integration fixes are in
      `docs/fnn-compat.md` → "Hold-mode live session findings".

### P2 — channel opening robustness — ✅ DONE (2026-09-11, stub-tested + live floor lookup)
- [x] `classifyFundingAmount()` (packages/fiber-adapter/src/open-channel-defaults.ts):
      hard-block below 100 CKB (99 CKB initiator reserve + headroom), bump
      to the peer's gossiped floor otherwise. Peer floor wired LIVE:
      `RealFiberGateway.peerAutoAcceptFloor` paginates `graph_nodes`
      (driveThree's gossiped floor reads exactly 100 CKB). The
      ChannelManager classifies before every open and notifies the seat of
      any bump. Tests: `tests/fiber/open-channel-policy.test.ts`; live
      lookup in `tests/fiber/live-node.test.ts`.
- [x] Stuck-open detection: `RealFiberGateway.openChannel` abandons a
      NegotiatingFunding ghost after its 2-min poll and throws
      `ChannelOpenStalledError`; the ChannelManager retries exactly once.
      NOTE: `abandon_channel` probed live against a Closed corpse answers
      "not found" — corpses are terminal, stay cosmetic (P4's filter idea
      still stands); the stall path itself is stub-tested only.
      ALSO FIXED: the open-poll read `peer_pubkey`/`state_name` — fields
      rc7 does not return (`pubkey`/`state.state_name`), so it could never
      have recognized a materialized channel.
- [x] Funding fee rate: unchanged at 20000 (validated for ≤1000 CKB opens;
      the classifier/bump path reuses the same fee rate — re-check only if
      funding multi-thousand-CKB channels ever).

### P3 — web client on live nodes — implementation + simulated verification (2026-09-14)
- [x] Optional agent-format poker identity import in the browser, validated and
      kept only in the tab. Existing saved browser identity remains available.
- [x] Local companion relay (`apps/player-agent/src/companion.ts`): one upstream
      session, browser-signed actions forwarded unchanged, configured player FNN
      identity declared on join, optional invoice payment via the existing gateway.
      **Correction to the earlier plan:** merely sharing a key between two direct
      connections does not work: SessionManager replaces the old connection.
      Run the companion instead of the headless playing agent for this player.
- [x] PAYMENT_REQUIRED/PAYMENT_STATUS preserved, with distinct local companion
      observations. Only the table's authoritative commit moves chips. Local
      payment submission/failure never fabricates a commit or unlocks pending play.
- [x] Browser integration exercised against SimulatedFiberNetwork, including
      identity import, buy-in/blinds, signed raise and payment-before-commit.
- [x] **Live-node companion rehearsal PASSED (2026-09-14)**:
      `apps/web-client/browser/companion-live.spec.ts` (env-gated, mirrors
      the sim spec) drives the REAL browser UI through the companion
      against the real nodes: alice joins from the browser, the companion
      pays her buy-in + blinds over the player node, bob (headless agent)
      calls down with real payments, alice acts from the browser, the hand
      settles for real, conservation holds, zero page errors — 14s end to
      end. Gotchas: heads-up means the BUTTON acts first (the bot must be
      driven or its timeout-fold ends the hand before the browser acts).
- [x] **UI seat controls (2026-09-14)**: the table screen now has
      "Cash out & leave" (LEAVE_REQUEST → payout over the channel → back
      to the join screen) and "Top up" (TOP_UP → settled between hands,
      queued mid-hand with TOP_UP_QUEUED feedback). Covered in the sim
      browser spec (companion.spec.ts).
- [x] **Reconnect replay (2026-09-14)**: resyncing mid-hand replays the
      player's hole cards and, when the acting seat is theirs, their
      YOUR_TURN with the ORIGINAL deadline (resync never extends the
      timer). Server-side, in sendSnapshot.
- [x] **Automatic session capacity (2026-09-14)**: `ensureCapacity`
      (packages/fiber-adapter/src/capacity.ts) provisions a side's own
      spendable channel capacity toward a peer. The PlayerAgent ensures it
      before joining and retries a payment once after opening on
      insufficient-balance; the companion does the same around every
      payment; the table auto-opens table-funded capacity when the
      liquidity gate would refuse a join (FIBER_POKER_AUTO_CAPACITY, on
      by default). Manual provisioning is no longer required.
- [x] **Abandoned-payment hygiene (2026-09-14)**: a failed join/top-up
      settlement now resolves the node-side invoice: paid (late settle) →
      refunded over the channel immediately; open/held → cancelled so it
      can never be paid late. ImmediateFiberSettlement.cancel also
      cancels the actual node invoice now.
- [x] **Shared funding companion (2026-09-15)**: `--players N` serves N
      generated identities from one funded node — each browser claims one
      (round-robin IDENTITY_REQUEST; a second tab for the same identity is
      refused), and every paid invoice lands in a per-player spend ledger
      (`exportLedger()`: playerId/obligationId/reason/amount/time). One
      browser per served identity (a duplicate tab would replace the
      player's table session). Cash-out attribution = join ledger
      obligationIds against the table's event log. Tests:
      tests/integration/onramp.test.ts (4).
- [x] **Reconnect rehearsals (2026-09-15)**:
      tests/fiber/reconnect-rehearsal.test.ts covers the last two open
      scenarios — P10 seed-phase reconnect (dropper sat out via the
      anti-abort deadline, hand completes, automatic sit-in restores them
      for the next hand) and hold-mode reconnect (offline player's blinds
      HELD, timeout policy resolves their turns, holds finalize at
      settlement, payouts flow over the channel, reconnect + resync shows
      the settled outcome).
- [x] **LiquidityManager.topUp implemented (2026-09-15)**: opens
      table-funded capacity sized amount + 101 CKB occupied margin via
      ensureCapacity, then refreshes. `rebalance` (circular self-payment)
      remains a documented future milestone.

### P4 — persistence hardening on real nodes — ✅ core done (2026-09-11)
- [x] **Crash/restart cycle with `FileEventStore` against the REAL nodes**
      (`tests/fiber/live-restart.test.ts`, passed live): hard-kill mid-hand
      → restart → hash chain intact, seats/stacks restored, blinds already
      settled are NOT re-judged as failures (recovery skips obligations
      with a recorded terminal outcome), hand resolves via the restored
      turn timer, cash-out + one cooperative close. Enabling fixes:
      - the node-side **payment hash is now PERSISTED** in
        Payment/PayoutInflight events (`adapter.paymentHashFor`) — a fresh
        process could otherwise never ask the node what happened;
      - recovery resolves non-final ops **against the gateway**
        (invoiceStatus/paymentStatus); a paid-but-uncommitted collection is
        refunded immediately over the channel (keysend) and logged;
      - **recovery restores the session→channel map** from ChannelReady
        events — without it a restarted server pays out leaves but never
        closes the real channel (silently);
      - a failed cooperative close no longer eats the leave (logged,
        CHANNEL_STATUS CLOSE_FAILED, seat stays gone).
- [x] Ghost strategy: `abandon_channel` only for recent NegotiatingFunding
      stalls (the open-poll targets the newest pending channel under 10
      min old); Closed pending-list corpses are terminal, cannot be
      abandoned, and stay cosmetic.
- [ ] Optional still: filter ancient corpses out of `only_pending`
      listings at the gateway (cosmetic; nothing reads them anymore).

**Live-topology deployment note (learned the hard way):** rc7 has no
post-open funding RPC, and the acceptor contributes ZERO collateral on
this testnet — so a table-funded channel has no player-side capacity
(player payments stick at Open) and a player-funded one has no table-side
capacity (the liquidity gate refuses joins). Sessions need BOTH
directions: `tests/fiber/helpers/live-topology.ts`
(`ensureSessionCapacity`) opens compensating channels per direction; all
four live session suites call it before joining.

### P6 — live gap validation — ✅ DONE (2026-09-15)
- [x] **Watchtower / force-close live** (`tests/fiber/live-watchtower.test.ts`):
      both nodes run fnn's BUILT-IN watchtower (no config overrides → 60s
      check interval). It is healthy: 4 transport errors in September vs a
      25.6k-error June outage burst (public-RPC flakiness). The Watchtower
      RPC module needs the channel's settlement Privkey — not exercisable
      without key material. LIVE force-close exercised end to end:
      accepted instantly, both nodes reached `Closed` with balances
      settled on-chain within minutes; the counterparty's state view
      lagged ~20 min behind the closer's (watchtower-relevant window).
      The stale-commitment PUNISHMENT path is not RPC-stageable (fnn
      force-closes with its latest commitment by construction) — would
      need crafted on-chain settlement keys. Details in
      docs/fnn-compat.md §8.
- [x] **Multiparty-seed live** (`tests/fiber/live-multiparty-seed.test.ts`):
      P10's commit/reveal deck ran against the real nodes — seed
      commitments collected from both clients over WS, hand dealt from the
      combined seed, blinds/bets settled for real, DECK_REVEALED broadcast,
      both seats cashed out. Note: `SeedProtocolCompleted` is only appended
      when a non-revealer is sat out; honest clients produce
      SeedProtocolStarted + the deal itself as evidence.
- Also fixed while validating: RealFiberGateway.openChannel now
  set-difference-polls so it returns the NEW channel, never a
  pre-existing one to the same peer (the old behavior returned a pending
  or unrelated channel and once caused the wrong channel to be closed in
  a test).

### P5 — research tracks — partially delivered (2026-09-15)
- [x] P11 (crypto hardening): the Pohlig–Hellman cipher now runs over a
      fixed, Miller-Rabin verified 2048-bit SAFE prime
      (`SAFE_PRIME_2048` in the deck package; re-verified in
      `tests/fiber/mental-poker-hardening.test.ts`), and exponents are
      hash-derived 512-bit odd values (the old seed-scan produced
      brute-forceable exponents). Benchmarks: full 52-card 2-player deal
      5.9s Node / 2.0s Chromium (`browser/benchmark.spec.ts`).
- [x] P11 (shuffle secrecy fix): the prototype's per-player shuffle
      permutation was derived from the PUBLIC player id — the entire deal
      order was computable by anyone. It now derives from the player's
      PRIVATE exponent. Negative result recorded in
      docs/poker-channel-research.md: naive product-batching shuffle
      proofs are mathematically incorrect (honest shuffles fail the
      verifier; substitution absorbs into garbage that the deal-time
      plaintext check aborts); sound proofs need permutation-commitment
      constructions (Peng/BG-style) — design work.
- [x] P12 (adjudicator): `contracts/poker-channel-adjudicator/` — a no_std
      Rust lock script (ckb-std + libsecp256k1 recovery + blake2b) that
      mirrors `PokerChannelSim.adjudicate` rule-for-rule (co-signatures,
      conservation, sequence monotonicity, finalize payouts). COMPILES for
      riscv64imac (CKB VM). RESEARCH GRADE: unaudited, not deployed, low-s
      normalization pending. Build + layouts in the contract README.
- [ ] P11 (proofs): Bayer–Groth shuffle/decrypt proofs remain OPEN — the
      PROOF: seams document the wire-in points; the transcript already
      records every intermediate value for post-hoc dispute. Note: a
      proper Bayer–Groth argument needs a different algebraic setting
      (Pedersen commitments over a prime-order group) than the
      Pohlig–Hellman cipher provides — design work first, not a drop-in.
- [ ] P11 (mobile): on-device benchmark pending (V8 numbers recorded).

---

## 5. Gotchas that cost time (read before touching these areas)

1. **fnn rc7 invoice semantics** — see §3.2. Never "fix" the adapter back
   to payment_hash-only invoices.
2. **Hex amounts**: hand-written hex has caused THREE bugs (100,000 CKB
   typo; 10,000-for-1 CKB; 150-for-99). Always compute via
   `bigint.toString()` → `hexAmount()` or python `hex()`.
3. **`describe.skip` via ternary**: `const d = GATED ? describe : describe.skip`
   only works if the suite actually CALLS `d(...)`. A bare `describe(`
   inside the gated file runs the body unconditionally (bit us once).
4. **Agent session keys**: the live-agent test writes its own session files
   and builds the peer map from them. If you generate pairs anywhere else,
   keep them in sync or joins unmapped → liquidity gate rejects.
5. **`FUNDING_ABORTED` refund** is automatic and fast; `FUNDING_ABORTED`
   corpses in `only_pending` are cosmetic. Abandoned opens leave
   `NegotiatingFunding` ghosts with empty flags — also cosmetic.
6. **TestClient.waitFor** filters parked messages — when a test needs the
   FRESH message (e.g. post-restart), filter by sequence/hash, not type.
7. **Conservation assertion mid-hand**: assert `stack + handContribution`
   (+ pots/awards only at settlement), never `stack` alone.
8. **Fast sim ≠ fast live, and racy counts**: on the simulator hands chain
   in ms, so `state.handNo` can advance past your assertion mid-test —
   assert `>= N` and filter HAND_RESULT waits by distinct handId. On live
   nodes the opposite risk: settlement pacing varies, so give TOP_UP /
   HAND_RESULT waits generous (300s) budgets.
9. **Auto-restart races the between-hands window**: hands restart
   immediately after `DISTRIBUTE_POTS`. Anything that must run between
   hands (top-ups, leaves) must be QUEUED server-side, never timed by the
   client — that's what `topupQueue`/`leaveQueue` +
   `processMembershipQueues` are for.

---

## 6. Key file map

| Area | Path |
|---|---|
| Engine (pure) | `packages/poker-engine/src/` |
| Protocol/canonical/hashing | `packages/protocol/src/` |
| Deck services (V0/P10/P11) | `packages/deck/src/` |
| Event store + snapshots | `packages/persistence/src/` |
| Settlement adapters | `packages/settlement/src/` (fake, immediate-fiber, hold, poker-channel) |
| Fiber RPC + simulator | `packages/fiber-adapter/src/` (rpc, real, sim) |
| Table server | `apps/table-server/src/` (server.ts is the orchestrator) |
| Player agent | `apps/player-agent/src/agent.ts` |
| Web client | `apps/web-client/src/` |
| Live tests | `tests/fiber/live-*.test.ts`, `tests/chaos/` |
| Docs | `docs/` (protocol, threat-model, deployment, fnn-compat, research ×2) |
| Infra templates | `infra/` (ckb-devnet, fnn, watchtower) |
