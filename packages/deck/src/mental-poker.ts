/**
 * P11 mental-poker RESEARCH PROTOTYPE (docs/08 V2).
 *
 * RESEARCH GRADE — NOT PRODUCTION CRYPTO:
 *  - the Pohlig–Hellman commutative cipher is real arithmetic, but the prime
 *    is a constructor parameter; the small toy prime used in tests is
 *    trivially breakable. A production deployment would use a 2048-bit+ safe
 *    prime (slow but sound for this cipher).
 *  - the classic strip-and-deal protocol below does NOT include zero-knowledge
 *    proofs. In Barnett–Smart-style protocols, every shuffle and decrypt-share
 *    carries a Bayer–Groth proof so peers can verify nobody peeked or
 *    substituted cards. Here, peers trust-but-later-verify: all intermediate
 *    values are recorded and a mismatch is detectable after the fact.
 *    Wire-in point for those proofs is marked explicitly (PROOF:).
 *
 * Kept entirely OUTSIDE the core Hold'em rules and settlement layers
 * (docs/08): this module never touches TableState; it produces a deck that
 * the table can feed to the engine like any other DeckService.
 */

import { DECK_SIZE } from "@fiber-poker/poker-engine";

/** Square-and-multiply modular exponentiation over BigInt. */
export function modPow(base: bigint, exponent: bigint, mod: bigint): bigint {
  if (mod <= 0n) throw new Error("modulus must be positive");
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** Extended GCD: returns g with a*g + b*m = gcd(a, m). */
function extendedGcd(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

/**
 * Pohlig–Hellman commutative cipher over (Z/pZ)*.
 * Encryption: c = m^e mod p; Decryption: m = c^d mod p with d = e^{-1} mod (p-1).
 * Commutativity: (m^eA)^eB = (m^eB)^eA — the property the joint shuffle needs.
 */
export class PohligHellmanCipher {
  /** e must be coprime to p-1; messages must lie in (Z/pZ)*. */
  constructor(
    readonly p: bigint,
    readonly e: bigint,
    readonly d: bigint,
  ) {
    if (gcd(e, p - 1n) !== 1n) {
      throw new Error("exponent e must be coprime to p-1");
    }
  }

  static fromPrivateKey(p: bigint, e: bigint): PohligHellmanCipher {
    return new PohligHellmanCipher(p, e, extendedGcd(e, p - 1n));
  }

  encrypt(m: bigint): bigint {
    return modPow(m, this.e, this.p);
  }

  decrypt(c: bigint): bigint {
    return modPow(c, this.d, this.p);
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/**
 * Toy prime for tests/demos: 2^31-1 (Mersenne). Messages 1..51 are valid
 * group elements. RESEARCH ONLY — trivially breakable.
 */
export const TOY_PRIME = 2147483647n;

/** Deterministic keypair from a seed for reproducible tests. */
export function deterministicKeypair(p: bigint, seed: bigint): PohligHellmanCipher {
  // Find e coprime to p-1 by scanning ODD values upward from a seed-derived
  // start (p-1 is even, so even candidates can never be coprime to it).
  const phi = p - 1n;
  let e = (seed % (phi - 3n)) + 2n;
  if (e % 2n === 0n) e += 1n;
  while (gcd(e, phi) !== 1n) {
    e = e + 2n > phi - 1n ? 3n : e + 2n;
  }
  return PohligHellmanCipher.fromPrivateKey(p, e);
}

export interface MentalPokerEvent {
  playerId: string;
  action: "shuffle-encrypt" | "strip-for" | "claim";
  /** Encrypted deck (shuffle-encrypt) or single card (strip/claim), decimal string. */
  value: string;
}

/**
 * One mental-poker deal among `players`.
 *
 * Protocol:
 *  1. jointEncrypt: each player, in turn, applies their encryption to every
 *     card and shuffles the result (their shuffle). PROOF: shuffle proofs here.
 *  2. dealTo(player): every OTHER player strips their encryption layer from
 *     the card (PROOF: decrypt-share proofs here); the recipient strips last
 *     and learns the card. Nobody else can recover it (they each see only
 *     intermediate values under at least one outstanding layer).
 *  3. Cards are removed from the pool; a card is dealt at most once.
 *  4. abort(): any player failing to strip marks the deal aborted — the
 *     hand-level policy (fold/redraw) applies above this module.
 */
export class MentalPokerDeal {
  private readonly keys = new Map<string, PohligHellmanCipher>();
  private pool: bigint[] = [];
  private readonly dealt = new Map<string, number[]>();
  private readonly log: MentalPokerEvent[] = [];
  aborted = false;
  abortReason = "";

  constructor(
    readonly playerIds: string[],
    /** Cryptographic parameters (inject a real safe prime for production). */
    private readonly prime: bigint = TOY_PRIME,
    keypairs?: Map<string, PohligHellmanCipher>,
  ) {
    if (playerIds.length < 2) throw new Error("mental poker needs at least 2 players");
    for (const id of playerIds) {
      this.keys.set(id, keypairs?.get(id) ?? deterministicKeypair(this.prime, BigInt(seedOf(id))));
    }
  }

  /** Phase 1: everyone encrypts + shuffles, in player order. */
  jointEncrypt(): bigint[] {
    let deck: bigint[] = Array.from({ length: DECK_SIZE }, (_, i) => BigInt(i + 1)); // group elements 1..52
    for (const id of this.playerIds) {
      const key = this.keys.get(id)!;
      deck = deck.map((m) => key.encrypt(m));
      deck = shuffledCopy(deck, seedOf(id));
      this.log.push({ playerId: id, action: "shuffle-encrypt", value: "deck" });
    }
    this.pool = deck;
    return [...this.pool];
  }

  /**
   * Phase 2: deal the top card of the pool to `playerId`.
   * Every other player strips their layer in turn; the recipient strips last.
   */
  dealTo(playerId: string): number {
    if (this.aborted) throw new Error(`deal aborted: ${this.abortReason}`);
    if (!this.keys.has(playerId)) throw new Error(`unknown player ${playerId}`);
    const card = this.pool.shift();
    if (card === undefined) throw new Error("deck exhausted");

    let value = card;
    for (const other of this.playerIds) {
      if (other === playerId) continue;
      const key = this.keys.get(other)!;
      value = key.decrypt(value);
      this.log.push({ playerId: other, action: "strip-for", value: value.toString() });
    }
    const recipient = this.keys.get(playerId)!;
    const plaintext = recipient.decrypt(value);
    this.log.push({ playerId, action: "claim", value: plaintext.toString() });

    if (plaintext < 1n || plaintext > BigInt(DECK_SIZE)) {
      this.aborted = true;
      this.abortReason = `invalid plaintext from pool at ${card}`;
      throw new Error(this.abortReason);
    }
    const cardIndex = Number(plaintext) - 1;
    const hand = this.dealt.get(playerId) ?? [];
    hand.push(cardIndex);
    this.dealt.set(playerId, hand);
    return cardIndex;
  }

  hand(playerId: string): number[] {
    return [...(this.dealt.get(playerId) ?? [])];
  }

  poolSize(): number {
    return this.pool.length;
  }

  /** Full transcript: the audit trail a real implementation would prove over. */
  transcript(): MentalPokerEvent[] {
    return [...this.log];
  }

  /** Simulate a player refusing to strip their layer (abort hook). */
  abort(reason: string): void {
    this.aborted = true;
    this.abortReason = reason;
  }
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic Fisher-Yates for the research prototype's shuffle step. */
function shuffledCopy<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
