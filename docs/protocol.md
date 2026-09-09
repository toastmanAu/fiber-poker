# Fiber Poker Wire Protocol (protocolVersion 1)

Frozen for protocolVersion 1. Any change to this document requires bumping
`protocolVersion` and changing the domain-separation strings.

## Transport

WebSocket, JSON messages:

```json
{
  "type": "STATE_COMMIT",
  "protocolVersion": 1,
  "messageId": "lz3k1j-3f2a",
  "tableId": "fiber-poker-table-1",
  "handId": "fiber-poker-table-1-h3-lx2a",
  "sequence": "42",
  "payload": { }
}
```

Money is **always** a decimal string of shannons (`"100000000"` = 1 CKB).
BigInts never travel as JSON numbers.

## Message vocabulary

Client → server: `HELLO`, `AUTH_RESPONSE`, `JOIN_TABLE`, `READY`,
`ACTION`, `LEAVE_REQUEST`, `SIT_IN`, `SIT_OUT`, `ACK_STATE`, `RESYNC`,
`PING`, `DECK_AUDIT`.

Server → client: `WELCOME`, `AUTH_CHALLENGE`, `AUTH_OK`, `AUTH_FAILED`,
`TABLE_SNAPSHOT`, `PLAYER_JOINED`, `PLAYER_LEFT`, `SEAT_STATUS`,
`CHANNEL_STATUS`, `HAND_START`, `HOLE_CARDS` (targeted), `YOUR_TURN`
(targeted), `PAYMENT_REQUIRED` (targeted), `PAYMENT_STATUS`,
`ACTION_ACCEPTED`, `ACTION_REJECTED`, `STATE_COMMIT`, `STREET_CHANGED`,
`HAND_RESULT`, `DECK_REVEALED`, `TIMER`, `ERROR`, `PONG`, `SERVER_CLOSING`.

Privacy: `HOLE_CARDS` and `PAYMENT_REQUIRED` go only to the authenticated
connection of the intended player. Broadcasts never contain raw hole cards.

## Authentication

1. Client sends `HELLO { pubkey }` (33-byte compressed secp256k1, hex,
   lowercase — the same format as a Fiber node pubkey).
2. Server replies `AUTH_CHALLENGE { challengeId, challenge }` where
   `challenge = BLAKE2b-256(personalization "ckb-default-hash",
   "FIBER_POKER/AUTH_CHALLENGE/V1" || randomNonce)`.
3. Client signs the 32-byte challenge with its identity key and sends
   `AUTH_RESPONSE { pubkey, challengeId, signature }` (64-byte compact
   r||s, hex).
4. Challenges expire after 30 seconds. The pubkey becomes the player id and
   the Fiber channel peer correlation key.

## Canonical action envelope

```json
{
  "protocolVersion": 1,
  "tableId": "…", "handId": "…",
  "sequence": "43", "previousStateHash": "<64 hex>",
  "actorPubkey": "<66 hex>",
  "actionType": "BET", "amountShannons": "200000000",
  "nonce": "<unique per session>",
  "signature": "<128 hex>"
}
```

`actionHash = BLAKE2b-256("ckb-default-hash", canonicalAction)` where
`canonicalAction` is the deterministic binary encoding (below) of
`"FIBER_POKER/ACTION/V1" || protocolVersion u32 || tableId || handId ||
sequence u64 || previousStateHash || actorPubkey || actionType || amount
u64 || payload || nonce` (strings are u32-length-prefixed UTF-8).

The acting player signs `actionHash`. The server verifies the signature,
the sequence, the previous state hash, and nonce freshness **before**
applying any rule.

Clients may submit only `CHECK | CALL | BET | RAISE | FOLD | ALL_IN`.
System actions (`START_HAND`, `POST_BLIND`, `TIMEOUT_*`,
`DISTRIBUTE_POTS`, `ABORT_HAND`, seat management) are signed by the table
key and are rejected from clients.

## Replay protection

An action is rejected unless ALL hold:

- `sequence == tip.sequence + 1` (else `STALE_SEQUENCE` / `SEQUENCE_GAP`);
- `previousStateHash == tip.stateHash` (`WRONG_PREVIOUS_STATE_HASH`);
- the nonce was never used before (`DUPLICATE_NONCE`);
- the signer is the authenticated session's own key (`WRONG_KEY`).

## State hash chain

The chain is computed over the **public projection** of the table state:
hole cards are replaced by per-seat commitments
(`H("FIBER_POKER/HOLE_CARDS/V1" || handId || cards)`), the undealt deck is
omitted (the deck commitment binds it), so every client can verify every
hash in real time from public data.

```
genesis = H(STATE || 0^32 || 0^32 || canonicalState0)
stateHash[n+1] = H(STATE || stateHash[n] || actionHash[n] || canonicalState[n+1])
```

with `STATE = "FIBER_POKER/STATE/V1"` (length-prefixed). The table signs
each step: `tableSig = Sign_tableKey(H("FIBER_POKER/TABLE_COMMIT/V1" ||
prevHash || actionHash || stateHash))` and broadcasts
`STATE_COMMIT { sequence, actionHash, previousStateHash, stateHash, summary,
signature, state }`.

## Canonical binary encoding (for hashing/signing)

- unsigned little-endian fixed-width integers: `u8`, `u32`, `u64`
- bytes: `u32` length prefix + raw
- string: `u32` length prefix + UTF-8
- bool: one byte `0x00`/`0x01`
- arrays: `u32` count + concatenated encodings
- optional: `0x00` absent / `0x01` present + encoding

Reference implementation: `packages/protocol/src/canonical.ts`.

## Deck fairness (V0)

Before dealing, the table broadcasts
`commitment = H("FIBER_POKER/DECK_COMMIT/V1" || handId || permutation || nonce)`
where `permutation` is a CSPRNG Fisher–Yates shuffle of 0..51 and `nonce`
is 16 random bytes. After the hand completes it broadcasts
`DECK_REVEALED { handId, permutation, nonce, commitment }`. Clients verify
the commitment and that the dealt cards match the revealed permutation.

**This proves the deck did not change after commitment. It does NOT prove
the dealer chose an unfavorable shuffle before committing — the server sees
all cards.** V1 (multiparty seed commit/reveal) and V2 (mental poker) are
interface stubs in `packages/deck`.

## State acknowledgements

After verifying a `STATE_COMMIT` (signature + chain re-hash), clients send
`ACK_STATE { sequence, stateHash }`. The server appends a
`StateAckRecorded` event (idempotent per player per state) and includes a
per-player ack summary in `TABLE_SNAPSHOT`. Acks are dispute evidence:
they prove which players observed and implicitly accepted which states.
Acks are never required for the chain to advance.

## Payment-before-commit

Value-changing actions carry a settlement obligation correlated by
`obligationId = handId:sequence:reason:playerId` and a deterministic
`paymentHash = H("FIBER_POKER/OBLIGATION/V1:" || tableId || ":" || handId
|| ":" || obligationId)`. The server persists `SettlementPlanned` →
`PaymentInflight` (with the Fiber payment hash) → `PaymentSucceeded` /
`PaymentFailed` in the event log, and only then commits the poker action.
See `docs/fnn-compat.md` for the exact FNN v0.9.0 RPC mapping.
