/**
 * Hashing and domain separation.
 *
 * CKB-ecosystem-friendly choice: BLAKE2b-256 with the personalization
 * "ckb-default-hash" — the same construction CKB itself uses, available
 * everywhere in that ecosystem and implemented by @noble/hashes.
 *
 * Domain-separation strings are FROZEN for protocolVersion 1. Changing any
 * of them changes every hash and every signature (see docs/protocol.md).
 */

import { blake2b } from "@noble/hashes/blake2b";

export const DOMAIN_ACTION = "FIBER_POKER/ACTION/V1";
export const DOMAIN_STATE = "FIBER_POKER/STATE/V1";
export const DOMAIN_DECK_COMMIT = "FIBER_POKER/DECK_COMMIT/V1";
export const DOMAIN_AUTH_CHALLENGE = "FIBER_POKER/AUTH_CHALLENGE/V1";
export const DOMAIN_TABLE_COMMIT = "FIBER_POKER/TABLE_COMMIT/V1";
export const DOMAIN_HOLE_CARDS = "FIBER_POKER/HOLE_CARDS/V1";
export const DOMAIN_SEED = "FIBER_POKER/SEED/V1";
export const DOMAIN_DECK_SEED = "FIBER_POKER/DECK_SEED/V1";

/** ckbHash: BLAKE2b-256 with personalization "ckb-default-hash". */
export function ckbHash(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return blake2b(buf, { dkLen: 32, personalization: "ckb-default-hash" });
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(out[i])) throw new Error(`invalid hex at ${i * 2}`);
  }
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return buf;
}
