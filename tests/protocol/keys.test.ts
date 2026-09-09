import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";

/** Deterministic CSPRNG substitute so key fixtures are reproducible. */
function seededRandom(seed: number): (n: number) => Uint8Array {
  let a = seed >>> 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
    }
    return out;
  };
}

describe("key generation determinism", () => {
  it("produces reproducible keypairs from a seeded CSPRNG", () => {
    const kp1 = generateKeyPair(seededRandom(42));
    const kp2 = generateKeyPair(seededRandom(42));
    expect(kp1).toEqual(kp2);
    // Compressed secp256k1 pubkey: 33 bytes, prefix 02 or 03.
    expect(kp1.publicKey).toMatch(/^(02|03)[0-9a-f]{64}$/);
  });
});
