/** Hex helpers shared by the fiber adapter. */

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexAmount(shannons: bigint): string {
  if (shannons < 0n) throw new Error("negative amount");
  return `0x${shannons.toString(16)}`;
}

export function parseAmount(hex: string | number): bigint {
  if (typeof hex === "number") return BigInt(hex);
  if (hex === "0x" || hex === "") return 0n;
  return BigInt(hex);
}
