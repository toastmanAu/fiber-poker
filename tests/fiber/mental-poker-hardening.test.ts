/**
 * P11 hardening: the mental-poker cipher's group parameters.
 *
 *  - SAFE_PRIME_2048 is re-verified as a SAFE prime on every run (p and
 *    q=(p-1)/2 both prime, Miller-Rabin): the embedded constant cannot rot.
 *  - Exponents are hash-derived 512-bit odd values coprime to p-1.
 *  - A full joint deal over the 2048-bit prime produces valid, disjoint
 *    hands. Benchmarks document the real cost (modexp-bound).
 */

import { describe, expect, it } from "vitest";
import {
  deterministicKeypair,
  isProbablePrime,
  MentalPokerDeal,
  PohligHellmanCipher,
  safePrimeCofactor,
  SAFE_PRIME_2048,
  TOY_PRIME,
} from "@fiber-poker/deck";

describe("mental poker 2048-bit hardening", () => {
  it("SAFE_PRIME_2048 is (still) a safe prime", () => {
    expect(SAFE_PRIME_2048.toString(2).length).toBe(2048);
    expect(isProbablePrime(SAFE_PRIME_2048)).toBe(true);
    expect(isProbablePrime(safePrimeCofactor(SAFE_PRIME_2048))).toBe(true);
  });

  it("keys are hash-derived 512-bit odd exponents, valid under the cipher", () => {
    const key = deterministicKeypair(SAFE_PRIME_2048, 7n);
    expect(key.e % 2n).toBe(1n);
    expect(key.e > 2n ** 500n).toBe(true);
    // The cipher's own invariant doubles as the coprimality check.
    expect(key.decrypt(key.encrypt(123456789n))).toBe(123456789n);
  });

  it("a full two-player deal over the 2048-bit prime is valid and disjoint", () => {
    const deal = new MentalPokerDeal(["alice", "bob"]);
    const started = performance.now();
    deal.jointEncrypt();
    const hands: number[][] = [[], []];
    let next = 0;
    while (deal.poolSize() > 0) {
      const player = next % 2 === 0 ? "bob" : "alice";
      hands[next % 2].push(deal.dealTo(player));
      next += 1;
    }
    const ms = Math.round(performance.now() - started);
    console.log(`[benchmark] full 52-card deal (2 players, 2048-bit prime): ${ms}ms`);
    expect(ms).toBeLessThan(60_000);
    for (const hand of hands) {
      expect(hand).toHaveLength(26);
      for (const card of hand) expect(card).toBeGreaterThanOrEqual(0);
    }
    expect(new Set([...hands[0], ...hands[1]]).size).toBe(52);
  }, 120_000);

  it("explicit keypairs interoperate over the safe prime", () => {
    const key = deterministicKeypair(SAFE_PRIME_2048, 99n);
    const cipher = PohligHellmanCipher.fromPrivateKey(SAFE_PRIME_2048, key.e);
    expect(cipher.decrypt(cipher.encrypt(42n))).toBe(42n);
  });

  it("the toy prime still works for fast tests", () => {
    const deal = new MentalPokerDeal(["a", "b"], TOY_PRIME);
    deal.jointEncrypt();
    const card = deal.dealTo("a");
    expect(card).toBeGreaterThanOrEqual(0);
    expect(card).toBeLessThan(52);
  });
});
