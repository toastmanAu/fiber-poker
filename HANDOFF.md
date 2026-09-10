# Session Handoff — Fiber Poker

**Last updated:** 2026-09-11
**Repo:** https://github.com/toastmanAu/fiber-poker (branch `master`)
**Working copy on the laptop:** `~/fiber-poker/fiber-poker`
**Original spec handoff:** `~/fiber-poker/fiber-poker-agent-handoff/`

This file is the resume point for the next session. It records exactly where
the project stands, how to reach the live test environment, and what remains.

---

## 1. Project status — all roadmap milestones have working code

| Milestone | State |
|---|---|
| P0–P8 (engine → web client) | ✅ production code, 105 unit/integration tests green |
| P9 hold-invoice experiment | ✅ implemented, live-verified primitives |
| P10 multiparty seed commit/reveal | ✅ implemented + e2e tests |
| P11 mental poker | ✅ research prototype + `docs/mental-poker-research.md` |
| P12 generalized CKB poker channel | ✅ simulator + `docs/poker-channel-research.md` |
| **Live testnet validation** | ✅ real money moved on `fnn 0.9.0-rc7` (details §3) |
| **Player agent** | ✅ `apps/player-agent`, live-verified (details §3) |

Suite: **105 pass + 7 gated-skip (live tests run only with env vars)**.
Typecheck clean. Everything committed and pushed.

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
```

Channel state (2026-09-11): **4 ChannelReady channels** between the nodes.
Table outbound ≈ 486 CKB (1 + 400 + ~85 split), player outbound ≈ 450+ CKB.
Both wallets also hold on-chain change (table ~194k CKB across 9 cells,
driveThree ~100k in 1 cell). Stale ghost channels in `list_channels
{only_pending:true}` are cosmetic residue of sub-floor opens — no funds.

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

---

## 4. Remaining work (prioritized)

### P1 — finish the live 2-player table story
- [ ] **Multi-hand session on live nodes**: current live test plays ONE
      hand. Extend to a multi-hand session with buy-in top-ups between
      hands and a final cash-out (leave flow: finish hand → payout →
      cooperative `shutdown_channel` → seat removed) — the leave/cash-out
      flow is written but only fake-mode tested.
- [ ] **6-agent live demo**: scale the 2-agent harness to 6 seats (the
      shared-player-node trick means only ONE fiber node is needed as the
      backing for all 6). Watch side pots + odd chips with real money.
- [ ] **Hold-mode live test** (P9): the hold invoice primitives are
      live-verified; run `HoldInvoiceSettlement` table server against the
      real nodes (set `FIBER_POKER_SETTLEMENT=hold`) and verify
      hold-at-bet → settle-at-hand-end over the wire.

### P2 — channel opening robustness
- [ ] Wire `classifyFundingAmount()` (scaffolded in the other agent's
      `~/fiber-hack/packages/core/src/open-channel-defaults.ts`): block
      below 99 CKB reserve, warn between reserve and the peer's actual
      floor read from `graph_nodes[].auto_accept_min_ckb_funding_amount`
      (identity field is `pubkey`; paginate via `last_cursor`).
- [ ] Stuck-open detection in `ChannelManager`: after open, poll; if
      `NegotiatingFunding && !is_acceptor` past timeout → `abandon_channel`
      + retry at a higher amount. Never leave pinned ghosts.
- [ ] Verify the funding fee rate scales: 20000 was validated for ~500 CKB
      opens; re-check for larger funding if used.

### P3 — web client on live nodes
- [ ] The browser client still targets fake-settlement tables. With the
      player agent running beside it (same session key directory), the web
      UI can spectate/act while the agent pays. Wire the web client's
      session-key storage to optionally load the agent's key file.
- [ ] Surface `PAYMENT_REQUIRED`/`PAYMENT_STATUS` transitions distinctly
      in the status chips (design exists in `main.ts`, verify end-to-end).

### P4 — persistence hardening on real nodes
- [ ] The live suites use InMemory event stores. One full server-restart
      cycle with `FileEventStore` against the REAL nodes (crash mid-hand,
      restart, reconcile non-final invoices by obligationId) would close
      the last gap vs the chaos suite's fake-adapter coverage.
- [ ] Reconcile abandoned-channel ghosts: fnn has no cleanup RPC (source
      comment admits it); decide whether to filter `only_pending` listing
      older than N hours in the gateway.

### P5 — research tracks (documented, no code owed)
- [ ] P11: benchmark `geometryxyz/mental-poker` on mobile; swap the toy
      Pohlig–Hellman cipher for a 2048-bit safe prime behind the same
      `MentalPokerDeal` interface; add Bayer–Groth proofs at the
      `PROOF:` seams.
- [ ] P12: CKB adjudicator script (~300 lines mirroring
      `PokerChannelSim.adjudicate`); Perun evaluation checklist in
      `docs/poker-channel-research.md`.

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
