# Threat Model (V0)

Read this before making any claim about the system's trust properties.

## What the table server is

The V0 table is an **authoritative but auditable** coordinator. It is
trusted for:

- action ordering;
- dealing and card secrecy;
- shuffle selection **before** commitment;
- payout decision execution;
- availability (it can censor or stall you).

It is **not** trustless, not decentralized poker, and not a provably fair
dealer. UI copy, README, and marketing must not claim otherwise.

## What Fiber/CKB protect

- channel state cryptography: a stale commitment cannot close a channel
  while a watchtower or the counterparty holds a revocation witness;
- settlement paths: funds move only through valid bilateral channel
  transitions;
- the poker engine and event log make coordinator misbehaviour
  **detectable after the fact** (deterministic replay, signed chain,
  deck commitment), not impossible.

## Threats and mitigations

### Malicious player

| Threat | Mitigation |
| --- | --- |
| Replay old/signed-contradictory actions | strict sequence + previous-state-hash + nonce dedup + signature over canonical bytes |
| Act out of turn | engine rejects `OUT_OF_TURN`; server double-checks with a dry-run |
| Disconnect to stall | deterministic timer: auto-check if legal, else auto-fold; seat retained |
| Bet without paying | payment-before-commit: the action commits only after settlement reaches SUCCEEDED |
| Spam join/action API | challenge-response auth, token-bucket rate limits, message size caps |
| Force close a channel | recovery path only; watchtower monitors for stale commitments; seat reuse blocked until resolved |

### Malicious or buggy coordinator

| Threat | Mitigation |
| --- | --- |
| Reorder/invent actions | sequence + hash chain; clients verify every commit hash |
| Lie about cards | post-hand deck reveal; per-seat hole-card commitments are verifiable by anyone |
| favourable shuffle before commitment | NOT mitigated in V0 — the server sees all cards. V1 multiparty seed / V2 mental poker address this |
| Censor a player | detection only (audit log); availability is trusted in V0 |
| Wrong payout | deterministic pot derivation in the pure engine; awards are recomputable from the event log |
| Duplicate a payment after crash | durable obligation ↔ payment-hash mapping; recovery reconciles non-final Fiber ops exactly once (chaos-tested) |

### Credential compromise

- Privileged FNN RPC credentials and Biscuit tokens live only in the
  server process. The browser client holds only its own identity key
  (generated in the browser, used for session signing).
- Logs never contain private keys, preimages, or unrevealed cards.

## Watchtower

Mobile players sleep. Offline protection is required for
production-like testing: the table runs a watchtower path for its own
channels, and player-side watchtower coverage is part of the deployment
guide (`docs/deployment.md`). Force close is a recovery path, never the
default exit.

## Residual risks accepted in V0

1. The coordinator is a single point of trust and availability.
2. Deck fairness is commit-then-reveal, not dealing-fairness.
3. Star-topology liquidity fragmentation is mitigated by oversized
   table-side funding on devnet; the LiquidityManager pauses hands when
   payout capacity is insufficient, but rebalancing is not automated.

## Force-close and watchtower posture (tested)

- Unilateral (force) close is simulated with a dispute delay: the closer's
  funds return immediately, the counterparty payout matures after the
  delay (`tests/fiber/force-close.test.ts`).
- A stale commitment broadcast (claimed commitment version older than the
  version a registered watchtower witnessed) is PUNISHED: the cheater
  forfeits their channel balance. An unregistered tower cannot punish —
  watchtower coverage is part of the deployment requirements
  (`docs/deployment.md`).
- The table monitors for unexpected channel closures: the affected seat is
  blocked (`BLOCKED_CLOSURE`), hands pause, and a `ChannelClosed` event is
  persisted; reopening requires the explicit operator path
  (`resolveClosure`) — never "continue and hope".

## Dispute evidence (ACK_STATE)

Clients acknowledge every verified state commit (`ACK_STATE { sequence,
stateHash }`). Acks are appended to the event log (`StateAckRecorded`),
exposed in `TABLE_SNAPSHOT`, and recovered after restart. For any
committed sequence, the log proves which players have seen and implicitly
accepted which state — the raw material for future multi-party dispute
work (docs/14).
