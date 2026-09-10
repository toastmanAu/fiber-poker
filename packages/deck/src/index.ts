/**
 * Deck services.
 *
 * TRUST NOTE (docs/08): the V0 service proves the deck did not change after
 * commitment. It does NOT prove the dealer chose an unfavorable shuffle
 * before committing — the server sees all cards. Do not describe V0 as
 * provably fair dealing.
 */

import { DECK_SIZE, fullDeck } from "@fiber-poker/poker-engine";
import { CanonicalWriter } from "@fiber-poker/protocol";
import { DOMAIN_DECK_COMMIT, ckbHash, toHex } from "@fiber-poker/protocol";

export interface DeckCommitment {
  handId: string;
  /** H(DOMAIN_DECK_COMMIT || handId || permutation || nonce), hex. */
  commitment: string;
}

export interface DeckReveal {
  handId: string;
  /** permutation[i] = deck position of the i-th card dealt. */
  permutation: number[];
  /** 16-byte random nonce, hex. */
  nonce: string;
  commitment: string;
}

/** Compute the V0 commitment for a permutation + nonce. */
export function computeCommitment(handId: string, permutation: readonly number[], nonceHex: string): string {
  const w = new CanonicalWriter();
  w.domain(DOMAIN_DECK_COMMIT);
  w.string(handId);
  w.u8Array(permutation);
  w.string(nonceHex);
  return toHex(ckbHash(w.finish()));
}

/** Verify a reveal against a commitment (client-side audit). */
export function verifyReveal(reveal: DeckReveal): boolean {
  return computeCommitment(reveal.handId, reveal.permutation, reveal.nonce) === reveal.commitment;
}

/**
 * Turn a revealed permutation into the engine deck (draw order):
 * permutation[i] is the index (into a canonical 52-card ordering) of the
 * i-th card dealt, so deck[i] = canonicalOrder[permutation[i]].
 */
export function deckFromReveal(reveal: DeckReveal): number[] {
  const canonical = fullDeck();
  if (reveal.permutation.length !== DECK_SIZE) throw new Error("bad permutation length");
  const seen = new Set<number>();
  return reveal.permutation.map((p) => {
    if (p < 0 || p >= DECK_SIZE || seen.has(p)) throw new Error("invalid permutation");
    seen.add(p);
    return canonical[p]!;
  });
}

export interface DeckService {
  readonly kind: string;
  /** Called before dealing a hand; the commitment is broadcast pre-deal. */
  commitForHand(handId: string): Promise<DeckCommitment>;
  /** The engine deck (draw order) for this hand; kept private by the table. */
  deckForHand(handId: string): number[];
  /** Called after HAND_COMPLETE; the reveal is broadcast for audit. */
  revealForHand(handId: string): Promise<DeckReveal>;
}

/**
 * V0: server-side CSPRNG Fisher-Yates shuffle with pre-hand commitment and
 * post-hand reveal. Cryptographically secure randomness via WebCrypto
 * (available in Node >= 19 and all browsers).
 */
export class ServerCommitRevealDeck implements DeckService {
  readonly kind = "server-commit-reveal-v0";
  private pending = new Map<string, { deck: number[]; permutation: number[]; nonce: string; commitment: string }>();

  constructor(private readonly randomBytes: (n: number) => Uint8Array = webcryptoRandomBytes) {}

  async commitForHand(handId: string): Promise<DeckCommitment> {
    const permutation = shuffledPermutation(this.randomBytes);
    const nonce = toHex(this.randomBytes(16));
    const commitment = computeCommitment(handId, permutation, nonce);
    const canonical = fullDeck();
    const deck = permutation.map((p) => canonical[p]!);
    this.pending.set(handId, { deck, permutation, nonce, commitment });
    return { handId, commitment };
  }

  deckForHand(handId: string): number[] {
    const entry = this.pending.get(handId);
    if (!entry) throw new Error(`no committed deck for hand ${handId}`);
    return [...entry.deck];
  }

  async revealForHand(handId: string): Promise<DeckReveal> {
    const entry = this.pending.get(handId);
    if (!entry) throw new Error(`no committed deck for hand ${handId}`);
    return {
      handId,
      permutation: [...entry.permutation],
      nonce: entry.nonce,
      commitment: entry.commitment,
    };
  }
}

function webcryptoRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Fisher-Yates using rejection-sampled unbiased random bytes. */
function shuffledPermutation(randomBytes: (n: number) => Uint8Array): number[] {
  const perm = Array.from({ length: DECK_SIZE }, (_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = unbiasedBelow(randomBytes, i + 1);
    const tmp = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = tmp;
  }
  return perm;
}

/** Unbiased uniform integer in [0, bound) from CSPRNG bytes. */
function unbiasedBelow(randomBytes: (n: number) => Uint8Array, bound: number): number {
  if (bound <= 1) return 0;
  const max = Math.floor(0x100000000 / bound) * bound;
  for (;;) {
    const b = randomBytes(4);
    const v = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    if (v < max) return v % bound;
  }
}

/**
 * V2 placeholder: mental poker (Barnett–Smart style encrypted shuffles).
 * Must stay entirely outside the core Hold'em rules and settlement layers.
 */
export class MentalPokerDeck implements DeckService {
  readonly kind = "mental-poker-v2";
  private readonly reason = "mental poker is a research track (docs/08, geometryxyz/mental-poker)";

  async commitForHand(): Promise<DeckCommitment> {
    throw new Error(`NOT_IMPLEMENTED: ${this.reason}`);
  }
  deckForHand(): number[] {
    throw new Error(`NOT_IMPLEMENTED: ${this.reason}`);
  }
  async revealForHand(): Promise<DeckReveal> {
    throw new Error(`NOT_IMPLEMENTED: ${this.reason}`);
  }
}

export * from "./multiparty.ts";
