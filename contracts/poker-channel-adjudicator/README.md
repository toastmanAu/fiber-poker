# Poker channel adjudicator (P12 research prototype)

A CKB lock script that arbitrates the poker state channel's co-signed
allocations. It mirrors `PokerChannelSim.adjudicate`
(`packages/settlement/src/poker-channel.ts`) rule for rule:

1. every participant co-signed the submitted state,
2. balances conserve the epoch total (and the input balances),
3. the submitted sequence is not older than the stored sequence,
4. a finalized state pays each participant exactly their allocation.

The chain verifies signatures, conservation, and sequence — never poker.
Clients verify poker rules before co-signing; `game_state_hash` binds the
allocation to the published transcript so any third party can audit after
the fact (docs/14 enforcement split).

## Layouts

**Script args** (fixed for the epoch):

| offset | size | field |
|---|---|---|
| 0 | 16 | epoch_total (u128 BE) |
| 16 | 1 | participant_count (N) |
| 17 | 20·N | blake2b160(pubkey) per participant, in signing order |

**Cell data** (identical on input and output state cells):

| offset | size | field |
|---|---|---|
| 0 | 8 | sequence (u64 LE, monotonically non-decreasing) |
| 8 | 1 | finalized (0 live / 1 payouts released) |
| 9 | 1 | balance_count (== N) |
| 10 | 36·N | { pubkey_hash (20), amount (u128 BE) } |
| end | 32 | game_state_hash (blake2b256 of the poker transcript) |

**Witness** (WitnessArgs.lock): the co-signature blob — for each
participant in arg order, a 65-byte recoverable secp256k1 signature
(v ∈ {0,1}) over blake2b256(new cell data). Verification recovers each
pubkey, hashes it (blake2b160), and requires an exact bijection with the
args set — so the blob proves "every participant signed THIS state".

## Rules

* UPDATE (one output state cell): all N signatures recover to the args
  set; output balances conserve epoch_total and the input balances; the
  participant set is unchanged; `output.sequence >= input.sequence`;
  `output.finalized == 0`.
* FINALIZE (input `finalized == 1`): outputs must be exactly N payout
  cells — one per participant, lock hash = their pubkey_hash, capacity =
  their allocated amount. No state cell remains.

## Build

```sh
rustup target add riscv64imac-unknown-none-elf
cargo build --release --target riscv64imac-unknown-none-elf
# → target/riscv64imac-unknown-none-elf/release/poker-channel-adjudicator
```

The RISC-V toolchain: any `riscv64-unknown-elf-gcc` on PATH works for
ckb-std's C helper (xPack's `riscv-none-elf-gcc` with a symlink is fine).

## Status

RESEARCH GRADE — unaudited, not deployed. Differences from a production
contract to close before any real deployment:

* secp256k1 verification is in-script (libsecp256k1, recovery-based)
  rather than the ecosystem-standard system-cell exec pattern; an audit
  should compare both against the CKB sighash normalization.
* No challenge/dispute window: states commit instantly (the simulator's
  `disputeLog` marks where timeout semantics attach).
* Deposit path (epoch creation) and Fiber funding (docs/14 item 4) are
  out of scope here; the adjudicator covers dispute + payout only.
* Signature malleability: low-s normalization should be enforced.
