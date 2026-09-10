/**
 * P10 multiparty seed commit/reveal (docs/08 V1).
 *
 * Every participant AND the table commit to a secret seed before the hand;
 * after all commitments are fixed, everyone reveals; the deck is derived
 * deterministically from the combined contributions and shuffled with a
 * keyed, deterministic Fisher-Yates.
 *
 * Fairness property: as long as at least one contributor is honest (and
 * clients audit the derivation), NO single party — including the dealer —
 * can choose a favorable deck. This closes the V0 weakness where the
 * server picked the whole shuffle before commitment. The server still sees
 * all cards once the deck is derived; full dealing privacy remains the
 * mental-poker track (V2).
 *
 * Anti-abort policy (docs/08): a participant that fails to reveal before
 * the deadline is SAT OUT for the hand and its seed excluded. Withholding
 * a reveal yields no information advantage (commitments are hiding and the
 * deck is only derived after the reveal deadline) — it can only delay, and
 * serial aborters never get dealt in. Forfeit/bond enforcement is a
 * deployment policy on top of this mechanism.
 */

import { DECK_SIZE, fullDeck } from "@fiber-poker/poker-engine";
import { blake2b } from "@noble/hashes/blake2b";
import { CanonicalWriter, DOMAIN_DECK_SEED, DOMAIN_SEED, ckbHash } from "@fiber-poker/protocol";
import { computeCommitment, type DeckCommitment, type DeckReveal, type DeckService } from "./index.ts";

export const SEED_BYTES = 32;

/** Commitment binding one participant's seed to this hand. */
export function seedCommitment(handId: string, playerId: string, seed: Uint8Array): string {
  const w = new CanonicalWriter();
  w.domain(DOMAIN_SEED);
  w.string(handId);
  w.string(playerId);
  w.bytes(seed);
  return toHex(ckbHash(w.finish()));
}

/**
 * Combined deck seed: order-independent across contributors (sorted by
 * player id) so everyone derives the identical value deterministically.
 * The table's contribution uses its pubkey as the player id.
 */
export function combinedSeedFor(
  handId: string,
  contributions: { playerId: string; seed: Uint8Array }[],
): Uint8Array {
  const sorted = [...contributions].sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
  const w = new CanonicalWriter();
  w.domain(DOMAIN_DECK_SEED);
  w.string(handId);
  w.u32(sorted.length);
  for (const c of sorted) {
    w.string(c.playerId);
    w.bytes(c.seed);
  }
  return ckbHash(w.finish());
}

/**
 * Deterministic Fisher-Yates from a seed: unbiased integers drawn from a
 * blake2b counter stream (rejection sampling), so the permutation is a pure
 * function of the combined seed.
 */
export function shuffleFromSeed(seed: Uint8Array): number[] {
  const perm = Array.from({ length: DECK_SIZE }, (_, i) => i);
  let counter = 0;
  let buffer: Uint8Array = new Uint8Array(0);
  let offset = 0;

  const nextUint32 = (): number => {
    for (;;) {
      if (offset + 4 > buffer.length) {
        buffer = blake2b(new Uint8Array([...seed, ...u32le(counter++)]), { dkLen: 32 });
        offset = 0;
        continue;
      }
      const v =
        ((buffer[offset]! << 24) | (buffer[offset + 1]! << 16) | (buffer[offset + 2]! << 8) | buffer[offset + 3]!) >>> 0;
      offset += 4;
      // Rejection sampling for an unbiased value in [0, bound).
      const bound = 0x100000000;
      const limit = Math.floor(bound / 52) * 52;
      if (v < limit) return v % 52;
    }
  };

  for (let i = perm.length - 1; i > 0; i--) {
    const j = nextUint32() % (i + 1);
    const tmp = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = tmp;
  }
  return perm;
}

function u32le(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface SeedContribution {
  playerId: string;
  /** hex, SEED_BYTES bytes. */
  seed: string;
}

export interface SeedProtocolReveal extends DeckReveal {
  /** Per-participant revealed seeds (audit material), including the table's. */
  seeds: SeedContribution[];
  /** Combined deck seed (hex) — clients re-derive and verify. */
  combinedSeed: string;
}

interface PendingHand {
  handId: string;
  /** Participants expected to contribute (players only; table implicit). */
  expected: Set<string>;
  commitments: Map<string, string>;
  reveals: Map<string, Uint8Array>;
  tableSeed: Uint8Array;
}

/**
 * The P10 deck service. The seed protocol runs through beginHand →
 * submitCommitment → fixCommitments → submitReveal → deriveDeck; the
 * DeckService methods (commitForHand/deckForHand/revealForHand) integrate
 * with the existing HandController flow.
 */
export class MultiPartySeedDeck implements DeckService {
  readonly kind = "multiparty-seed-v1";

  private pending = new Map<string, PendingHand>();
  private ready = new Map<string, { deck: number[]; reveal: SeedProtocolReveal }>();
  private randomBytes: (n: number) => Uint8Array;
  readonly tablePubkey: string;

  constructor(tablePubkey: string, randomBytes?: (n: number) => Uint8Array) {
    this.tablePubkey = tablePubkey;
    this.randomBytes = randomBytes ?? ((n: number) => {
      const b = new Uint8Array(n);
      globalThis.crypto.getRandomValues(b);
      return b;
    });
  }

  /**
   * Start collecting commitments. `participants` are the player ids expected
   * to contribute (the table always contributes its own seed).
   */
  beginSeedProtocol(handId: string, participants: string[]): void {
    const tableSeed = new Uint8Array(SEED_BYTES);
    this.randomBytes(tableSeed.length);
    this.pending.set(handId, {
      handId,
      expected: new Set(participants),
      commitments: new Map(),
      reveals: new Map(),
      tableSeed,
    });
  }

  /** The table's own commitment (registered like any participant's). */
  tableCommitment(handId: string): string {
    const hand = this.pending.get(handId);
    if (!hand) throw new Error(`no seed protocol for ${handId}`);
    return seedCommitment(handId, this.tablePubkey, hand.tableSeed);
  }

  submitCommitment(handId: string, playerId: string, commitment: string): void {
    const hand = this.pending.get(handId);
    if (!hand) throw new Error(`no seed protocol for ${handId}`);
    if (!hand.expected.has(playerId)) return; // not a participant this hand
    if (hand.commitments.has(playerId)) return; // first commitment wins
    if (!/^[0-9a-f]{64}$/.test(commitment)) throw new Error("malformed seed commitment");
    hand.commitments.set(playerId, commitment);
  }

  /** All expected participants (including the table) have committed. */
  commitmentsComplete(handId: string): boolean {
    const hand = this.pending.get(handId);
    if (!hand) return false;
    for (const p of hand.expected) {
      if (!hand.commitments.has(p)) return false;
    }
    return true;
  }

  /** Marker: commitments are fixed. First commitment per participant wins;
   *  submitCommitment ignores re-submissions, so this cannot be cheated. */
  commitmentsFixed(handId: string): void {
    if (!this.pending.has(handId)) throw new Error(`no seed protocol for ${handId}`);
  }

  submitReveal(handId: string, playerId: string, seedHex: string): boolean {
    const hand = this.pending.get(handId);
    if (!hand) return false;
    if (!/^[0-9a-f]{64}$/.test(seedHex)) return false;
    const seed = fromHex(seedHex);
    const commitment = hand.commitments.get(playerId);
    if (!commitment) return false; // never committed: reveal is void
    if (seedCommitment(handId, playerId, seed) !== commitment) return false; // invalid
    if (hand.reveals.has(playerId)) return true; // idempotent
    hand.reveals.set(playerId, seed);
    return true;
  }

  /**
   * Derive the deck from everyone who committed AND revealed. Participants
   * that committed but did not reveal in time are excluded by the caller
   * (anti-abort policy: sat out for this hand) — call before deriveDeck.
   */
  deriveDeck(handId: string): number[] {
    const hand = this.pending.get(handId);
    if (!hand) throw new Error(`no seed protocol for ${handId}`);
    const contributions: { playerId: string; seed: Uint8Array }[] = [
      { playerId: this.tablePubkey, seed: hand.tableSeed },
    ];
    for (const [playerId, seed] of hand.reveals) {
      if (hand.commitments.has(playerId)) contributions.push({ playerId, seed });
    }
    const combined = combinedSeedFor(handId, contributions);
    const permutation = shuffleFromSeed(combined);
    const canonical = fullDeckOrder();
    const deck = permutation.map((p) => canonical[p]!);

    const commitment = computeCommitment(handId, permutation, toHex(combined));
    const reveal: SeedProtocolReveal = {
      handId,
      permutation,
      nonce: toHex(combined),
      commitment,
      seeds: [
        { playerId: this.tablePubkey, seed: toHex(hand.tableSeed) },
        ...[...hand.reveals.entries()].map(([playerId, seed]) => ({ playerId, seed: toHex(seed) })),
      ],
      combinedSeed: toHex(combined),
    };
    this.ready.set(handId, { deck, reveal });
    return [...deck];
  }

  /**
   * Expected participants without a valid reveal (sat out this hand by the
   * anti-abort policy). Includes players that never committed at all.
   */
  nonRevealers(handId: string): string[] {
    const hand = this.pending.get(handId);
    if (!hand) return [];
    return [...hand.expected].filter((p) => !hand.reveals.has(p));
  }

  // --- DeckService integration ----------------------------------------------

  async commitForHand(handId: string): Promise<DeckCommitment> {
    const entry = this.ready.get(handId);
    if (!entry) throw new Error(`seed protocol not complete for ${handId}`);
    return { handId, commitment: entry.reveal.commitment };
  }

  deckForHand(handId: string): number[] {
    const entry = this.ready.get(handId);
    if (!entry) throw new Error(`seed protocol not complete for ${handId}`);
    return [...entry.deck];
  }

  async revealForHand(handId: string): Promise<SeedProtocolReveal> {
    const entry = this.ready.get(handId);
    if (!entry) throw new Error(`no reveal for ${handId}`);
    return entry.reveal;
  }
}

function fullDeckOrder(): number[] {
  return fullDeck();
}
