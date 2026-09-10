# P11 Research — Mental Poker (verifiable encrypted shuffle & deal)

Status: **research prototype implemented** (`packages/deck/src/mental-poker.ts`,
tests in `tests/fiber/research-prototypes.test.ts`). Research grade — not
production crypto. This module is deliberately OUTSIDE the core Hold'em
engine and settlement layers (docs/08).

## Goal

Remove the last dealer trust in the deck: with mental poker, no single
party — including the table — can know or choose any card before it is
dealt. P10 (multiparty seed) already prevents a *favorable shuffle*; mental
poker additionally prevents the dealer from *seeing* the deck.

## What the prototype demonstrates

Classic commutative-encryption dealing (Pohlig–Hellman over (Z/pZ)\*):

1. **Joint shuffle-encrypt**: each player applies their encryption to all
   52 cards and shuffles the result. After the last player, the deck is
   encrypted under every key in a stack; nobody can map positions to cards.
2. **Strip-deal**: to give the top card to player P, every other player
   strips (decrypts) their layer, in turn; P strips last and learns the
   card. Each intermediate value is still encrypted under at least one
   outstanding key, so a stripper learns nothing about the final card.
3. **Audit trail**: every shuffle and decrypt-share is recorded. In the
   prototype, peers trust-but-later-verify; a production system proves
   correctness inline (below).
4. **Abort hooks**: a player failing to strip marks the deal aborted; the
   hand-level policy (fold / redraw) applies above this module.

Verified by tests: commutativity/inversion, joint deal correctness and
card uniqueness across 3 players, transcript shape, abort semantics, and
the same arithmetic at a 61-bit prime (production shape).

## The gap to production

| Gap | What production needs | Reference |
| --- | --- | --- |
| Peeks/substitution by a malicious stripper | Zero-knowledge proofs on every shuffle and decrypt-share (Bayer–Groth shuffle argument; Chaum–Pedersen DDH pairs) | Barnett–Smart "mental poker revisited"; `geometryxyz/mental-poker` |
| Performance | 52 cards × N players × modPow over 2048-bit primes per hand, plus proof generation/verification. Mobile budget is the binding constraint (docs/08) | benchmark against the reference implementation |
| Proof size | Groth16/BG proofs add O(100s of bytes–KBs) per operation; batching matters | Bayer–Groth 2008 |
| Abort/decrypt-share refusal | Hand-level policy: forfeit/bond, or threshold decryption (t-of-N) so one refusal cannot stall the deal | docs/08 anti-abort options |
| Disconnect recovery | Encrypted-deck commitments are durable; resuming means re-requesting only the missing decrypt-shares for pending cards | this repo's event-sourced recovery patterns |
| Encoding | Cards must map into (Z/pZ)\* injectively with domain separation; prototype uses 1..52 over a prime > 52 | production: hash-to-group or injective padding |

## Recommended path

1. Keep `MentalPokerDeal`'s protocol skeleton (phases, transcript, abort
   hooks) and swap the toy cipher for a real prime + proof layer behind the
   same interface (`PROOF:` markers mark the exact seams).
2. Benchmark `geometryxyz/mental-poker` on a mid-range phone before
   committing to the Barnett–Smart variant.
3. Only after P12 exists: mental poker composes with the poker state
   channel by replacing `deckForHand` — the engine and settlement layers
   need zero changes (that separation is why docs/08 kept them apart).

## Non-goals

- Replacing the server in V0 deployment: mental poker changes the
  communication pattern (peer-to-peer dealing rounds); the authoritative
  table remains the coordination point that relays proofs.
- Post-quantum: Pohlig–Hellman/DH-style assumptions are not PQ. Out of
  scope until the rest of the stack is.
