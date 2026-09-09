/**
 * secp256k1 key handling and signatures over 32-byte message hashes.
 *
 * Keys are hex strings; pubkeys are 33-byte compressed (matching the Fiber
 * node pubkey format so seat identity can be correlated with channel peers).
 * Signatures are 64-byte compact r||s hex.
 *
 * @noble/curves is a constant-time, audited implementation usable in both
 * Node and browsers (the client signs its session challenge with it).
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { fromHex, toHex } from "./hash.ts";

export interface KeyPair {
  privateKey: string;
  publicKey: string;
}

export function generateKeyPair(randomBytes: (n: number) => Uint8Array): KeyPair {
  for (;;) {
    const priv = randomBytes(32);
    if (priv.every((b) => b === 0)) continue;
    try {
      const pub = secp256k1.getPublicKey(priv, true);
      return { privateKey: toHex(priv), publicKey: toHex(pub) };
    } catch {
      // ~2^-128 probability; regenerate.
      continue;
    }
  }
}

/** Sign a 32-byte message hash; returns 64-byte compact signature hex. */
export function signHash(privateKeyHex: string, messageHash: Uint8Array): string {
  if (messageHash.length !== 32) throw new Error("signHash expects a 32-byte hash");
  const sig = secp256k1.sign(messageHash, fromHex(privateKeyHex), { prehash: false });
  return toHex(sig.toBytes());
}

/** Verify a 64-byte compact signature over a 32-byte message hash. */
export function verifyHash(publicKeyHex: string, messageHash: Uint8Array, signatureHex: string): boolean {
  try {
    if (messageHash.length !== 32) return false;
    const sig = fromHex(signatureHex);
    if (sig.length !== 64) return false;
    return secp256k1.verify(sig, messageHash, fromHex(publicKeyHex), { prehash: false });
  } catch {
    return false;
  }
}

/** Derive the compressed public key for a private key. */
export function publicKeyFromPrivate(privateKeyHex: string): string {
  return toHex(secp256k1.getPublicKey(fromHex(privateKeyHex), true));
}

/** Validate a compressed pubkey hex string. */
export function isValidPublicKey(publicKeyHex: string): boolean {
  try {
    const b = fromHex(publicKeyHex);
    return b.length === 33 && (b[0] === 2 || b[0] === 3);
  } catch {
    return false;
  }
}
