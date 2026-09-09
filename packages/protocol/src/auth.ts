/**
 * Session authentication: the table challenges, the client proves control of
 * a secp256k1 key. The pubkey doubles as the player identity and the Fiber
 * channel peer correlation key.
 */

import { CanonicalWriter } from "./canonical.ts";
import { DOMAIN_AUTH_CHALLENGE, ckbHash } from "./hash.ts";
import { signHash, verifyHash } from "./keys.ts";

export interface AuthChallenge {
  challengeId: string;
  /** 32-byte hex the client must sign with its identity key. */
  challenge: string;
  issuedAt: number;
  expiresAt: number;
}

export function createChallenge(now: number, randomHex: () => string, ttlMs = 30_000): AuthChallenge {
  const nonce = randomHex();
  const challenge = toHex32(ckbHash(new CanonicalWriter().domain(DOMAIN_AUTH_CHALLENGE).string(nonce).finish()));
  return {
    challengeId: nonce.slice(0, 16),
    challenge,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
}

/** The client computes the signature over the challenge bytes. */
export function respondToChallenge(privateKey: string, challenge: AuthChallenge): string {
  return signHash(privateKey, hexToBytes(challenge.challenge));
}

export function verifyChallengeResponse(
  challenge: AuthChallenge,
  pubkeyHex: string,
  signatureHex: string,
  now: number,
): boolean {
  if (now < challenge.issuedAt || now > challenge.expiresAt) return false;
  return verifyHash(pubkeyHex, hexToBytes(challenge.challenge), signatureHex);
}

function toHex32(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
