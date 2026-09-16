/**
 * P11 mental-poker RESEARCH PROTOTYPE (docs/08 V2).
 *
 * The Pohlig–Hellman commutative cipher runs over a fixed, Miller-Rabin
 * verified 2048-bit SAFE prime (SAFE_PRIME_2048; generated with OpenSSL's
 * DH safe-prime generator and re-verified in tests). Exponents are
 * CSPRNG 512-bit values GENERATED PER DEAL — since d = e^{-1} mod (p-1)
 * and p is public, e must never be derivable by outsiders (a previous
 * version derived e from the public player id, which handed every player's
 * decryption key to everyone). The small TOY_PRIME remains for fast tests
 * only, and `deterministicKeypair` stays exported for reproducible tests.
 *
 * STILL RESEARCH GRADE:
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

import { ckbHash } from "@fiber-poker/protocol";
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

/**
 * Production group: a fixed 2048-bit SAFE prime (p = 2q + 1 with q prime),
 * generated with OpenSSL's DH safe-prime generator and Miller-Rabin
 * verified (22 bases) for both p and q; `tests/fiber/mental-poker-hardening
 * .test.ts` re-verifies primality on every run so the constant cannot rot.
 */
export const SAFE_PRIME_2048 =
  0xa46c75882e0ea9d45d65a6dfe66e409051887ac3ed46b3f20c1fc330b0828b3e2fe5611508efaa4a3b4491e186da5af6c6b73784929dcb7ab8dbabfaf452e5b6cd5f150452e162d31d6fbfb122ad5eff7819a4d19e0ce806c1857c543be3e9c63a71fbd7db6dfe8a5105b2da12b0d10d631c922da87dd28fce5629cbf623855c7769bc644ba18252b58b81d66eac121c7f66a393c382193ffe0c6764f6365910a109e39efd329693630827c4675787b0c44a0cd9387378eaed123cd9b0f90fa4f576aa395bcc7916f4ef2f52f335955d044881bbfd21c2b68e490337adc69a72a2530e6cbca6210bef458f7efde65331bf4510c2afbdd63ee3f59065478c8a37n;

/** Miller-Rabin over BigInt with fixed bases (deterministic; fine for
 *  verifying an EMBEDDED constant — never for key generation). */
export function isProbablePrime(n: bigint): boolean {
  if (n < 2n) return false;
  for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    if (n % a === 0n) return n === a;
  }
  let d = n - 1n;
  let r = 0n;
  while (d % 2n === 0n) {
    d /= 2n;
    r += 1n;
  }
  witness: for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1n; i < r; i++) {
      x = (x * x) % n;
      if (x === n - 1n) continue witness;
    }
    return false;
  }
  return true;
}

/** q = (p-1)/2 of a safe prime. */
export function safePrimeCofactor(p: bigint): bigint {
  return (p - 1n) / 2n;
}

/**
 * Deterministic keypair from a seed, safe at any prime size: the exponent
 * is expanded from the seed through the protocol hash into a 512-bit ODD
 * value (a 32-bit seed-derived exponent would be brute-forceable at
 * 2048-bit modulus sizes), then nudged until coprime to p-1 (expected one
 * or two steps: p-1 = 2q for the safe prime, so any odd e not divisible
 * by q works).
 */
export function deterministicKeypair(p: bigint, seed: bigint): PohligHellmanCipher {
  const phi = p - 1n;
  let acc = seed.toString(16);
  let e = 0n;
  for (let round = 0; round < 16; round++) {
    const digest = ckbHash(new TextEncoder().encode(`${acc}:${round}`));
    e = (e << 256n) | BigInt("0x" + toHex(digest));
  }
  e = (e % (phi - 3n)) + 2n;
  if (e % 2n === 0n) e += 1n;
  while (gcd(e, phi) !== 1n) {
    e = e + 2n > phi - 1n ? 3n : e + 2n;
  }
  return PohligHellmanCipher.fromPrivateKey(p, e);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
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
/** Fresh CSPRNG keypair — the production path (never public-id derived). */
export function randomKeypair(p: bigint): PohligHellmanCipher {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  let e = BigInt("0x" + toHex(bytes)) % (p - 3n) + 2n;
  if (e % 2n === 0n) e += 1n;
  while (gcd(e, p - 1n) !== 1n) {
    e = e + 2n > p - 2n ? 3n : e + 2n;
  }
  return PohligHellmanCipher.fromPrivateKey(p, e);
}

export class MentalPokerDeal {
  private readonly keys = new Map<string, PohligHellmanCipher>();
  /** card index -> group element (hash-derived; never the raw integer). */
  private readonly cardElements: bigint[] = [];
  private readonly cardByElement = new Map<string, number>();
  private pool: bigint[] = [];
  private readonly dealt = new Map<string, number[]>();
  private readonly log: MentalPokerEvent[] = [];
  aborted = false;
  abortReason = "";

  constructor(
    readonly playerIds: string[],
    /** Cryptographic parameters (TOY_PRIME for fast tests only). */
    private readonly prime: bigint = SAFE_PRIME_2048,
    keypairs?: Map<string, PohligHellmanCipher>,
  ) {
    if (playerIds.length < 2) throw new Error("mental poker needs at least 2 players");
    for (const id of playerIds) {
      // Keys are CSPRNG per deal. Deterministic keys derived from public
      // ids would hand every player's decryption key to everyone (d is
      // computable from a public e and the public p - 1).
      this.keys.set(id, keypairs?.get(id) ?? randomKeypair(this.prime));
    }
    // Card ELEMENTS: hash-derived group members. Raw integers 1..52 are
    // structurally broken in (Z/pZ)* — m = 1 encrypts to the constant 1
    // under every key (permanently exposed), and small m have degenerate
    // sub-order structure that leaks under arbitrary exponents.
    for (let i = 0; i < DECK_SIZE; i++) {
      const element = BigInt("0x" + toHex(ckbHash(new TextEncoder().encode(`FIBER_POKER/CARD/V1:${i}`)))) % this.prime;
      if (element === 0n || element === 1n) throw new Error("card element degenerate; regenerate prime");
      this.cardElements.push(element);
      this.cardByElement.set(this.cardElements[i]!.toString(), i);
    }
  }

  /** Phase 1: everyone encrypts + shuffles, in player order. */
  jointEncrypt(): bigint[] {
    let deck: bigint[] = [...this.cardElements];
    for (const id of this.playerIds) {
      const key = this.keys.get(id)!;
      deck = deck.map((m) => key.encrypt(m));
      // The shuffle permutation MUST be secret: seed it from the player's
      // private exponent, not from the public id (the old public seed made
      // the whole deal order computable by anyone). Deterministic for the
      // player (reproducible transcript), unpredictable to everyone else.
      deck = shuffledCopy(deck, secretShuffleSeed(key));
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
    const element = recipient.decrypt(value);
    this.log.push({ playerId, action: "claim", value: element.toString() });

    const cardIndex = this.cardByElement.get(element.toString());
    if (cardIndex === undefined) {
      this.aborted = true;
      this.abortReason = `invalid plaintext from pool at ${card}`;
      throw new Error(this.abortReason);
    }
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

/**
 * Secret shuffle seed: a 32-bit Fisher-Yates state dragged out of the
 * player's PRIVATE exponent through the protocol hash. Others cannot
 * compute it (d is secret) and the 2^32 surface is only brute-forceable
 * offline against the public transcript ordering — production would use a
 * full keystream (see docs/08 V2 notes).
 */
function secretShuffleSeed(key: PohligHellmanCipher): number {
  const digest = ckbHash(new TextEncoder().encode(`FIBER_POKER/SHUFFLE/SEED/V1:${key.d}`));
  const hex = [...digest].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
  return Number.parseInt(hex, 16) >>> 0;
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
