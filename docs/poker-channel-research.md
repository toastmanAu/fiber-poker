# P12 Research — Generalized CKB Poker State Channel

Status: **research prototype implemented**
(`packages/settlement/src/poker-channel.ts`, tests in
`tests/fiber/research-prototypes.test.ts`). The "chain" is an in-process
simulator — no CKB scripts. This module stays OUT of the live settlement
path: `FutureStateChannelSettlement` still refuses real obligations.

## The model (docs/14)

Buy-ins lock once per **table epoch** into a shared allocation. Poker hands
update a co-signed off-chain allocation state; the chain is touched only to
open, dispute, or close.

```
PokerChannelState {
  protocolVersion, tableEpoch, participantSet[], balances[],
  gameStateHash, sequence, finalized
}
```

Implemented in `PokerChannelSim`:

- **Open epoch**: buy-ins form the initial allocation; every participant
  co-signs (secp256k1 over the canonical state encoding,
  `FIBER_POKER/POKER_CHANNEL/V1` domain).
- **Hand settlement**: `applyHandResult(handId, gameStateHash, balances)`
  — the simulator verifies **conservation** (sum invariant) and bumps the
  sequence; all participants co-sign. `gameStateHash` binds the allocation
  to the deterministic poker state it settles (clients verify the poker
  rules against the same transcript the table publishes).
- **Disputes**: `adjudicate(state)` is the simulated chain contract. It
  accepts a state iff (1) every participant's signature verifies, (2)
  balances conserve the epoch total, (3) sequence >= the accepted latest.
  A **stale state** (sequence below latest) is rejected and logged —
  the honest party's latest co-signed state always supersedes.
- **Finalization**: the latest allocation is co-signed `finalized` and
  balances pay out of the escrow.
- **Membership**: changes only between epochs (docs/14 D009) — the epoch
  finalizes with the old set, the new epoch opens with the new set.

Test coverage: epoch lifecycle, conservation rejection, stale-state
disputes, missing-signature rejection, finalization payouts, and epoch
rotation with membership change.

## Enforcement split (docs/14's simpler variant)

The chain verifies **signatures, sequence, conservation** — nothing about
poker. Clients verify **poker rules** before co-signing. Trade-off
(documented in docs/14): a compromised client could co-sign an
economically valid but game-invalid allocation; the alternative
(chain-executes-Hold'em) is contract-complex and unbuildable today. The
mitigation in this architecture: every allocation carries `gameStateHash`,
and the full signed transcript + deck reveal lets any third party verify
that the allocation matches the game — after the fact.

## From simulation to CKB

What a real deployment adds, in build order:

1. **State cells + witness layout**: encode `PokerChannelState` as a CKB
   structure (the canonical encoding here is already the draft witness
   format); one lock cell per epoch, balances as UDT or capacity.
2. **Adjudicator script**: verify a BLS/secp256k1 multi-signature (or N-of-N
   secp256k1 sighash-all style), conservation, and sequence monotonicity
   against the cell's stored sequence. This is the ~300-line script the
   simulator's `adjudicate` mirrors.
3. **Challenge window**: real chains need a timed dispute window instead of
   instant acceptance; the simulator's `disputeLog` shows exactly where
   timeout semantics attach.
4. **Funding/cash-out via Fiber** (docs/14): players open a Fiber channel
   to a funding endpoint to move funds in/out of epoch cells without
   on-chain round trips per hand.
5. **Dynamic membership**: epoch rotation is already between-hands; the
   open question is whether a new participant's buy-in cell can join a
   live channel cell (probably: new epoch cell built from old payouts).

## Perun evaluation checklist (docs/12 D010)

- [ ] go-perun multiparty (>2) support status — last reviewed: n-party
      channels exist in research branches, not in the stable CKB backend.
- [ ] CKB backend maintenance state vs current ckb-vm/CC.
- [ ] State serialization vs this repo's canonical encoding.
- [ ] Dispute mechanics mapping (Perun's registered vs concluded phases).
- [ ] Script cost on CKB (signature verification dominates).
- [ ] Native CKB vs UDT for balances.

Do not fork Perun before a minimal poker-channel state machine has been
simulated off-chain — which is exactly what `PokerChannelSim` now is.

## Open problems

1. **Lazy co-signing**: a participant offline at hand end cannot co-sign;
   need skip-charges or a grace window (P9 hold-invoices could escrow the
   obligation until they return).
2. **Deck privacy composition**: the channel settles allocations; the deck
   track (P10/P11) decides them. Their `gameStateHash` handshake needs one
   canonical definition of "poker state hash" (currently the public-view
   chain hash).
3. **Partial payouts mid-epoch**: players wanting to leave mid-session
   need an epoch close or an in-channel unilateral exit path.
