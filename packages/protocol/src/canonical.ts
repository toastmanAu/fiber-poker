/**
 * Deterministic binary encoding used for every hashed/signed structure.
 *
 * Rules (frozen for protocolVersion 1, see docs/protocol.md):
 *  - unsigned little-endian integers with fixed widths (u8, u32, u64)
 *  - bytes   : u32 length prefix + raw bytes
 *  - string  : u32 length prefix + UTF-8 bytes
 *  - bool    : single byte, 0x00 or 0x01
 *  - arrays  : u32 element count + concatenated encodings
 *  - optional: 0x00 absent / 0x01 present + encoding
 *  - every hashed/signed message starts with a domain-separation string
 *
 * There is no reflection and no JSON in this path: the encoding is a pure
 * function of field order, so identical structures always produce identical
 * bytes on every platform.
 */

export class CanonicalWriter {
  private chunks: number[] = [];

  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`u8 out of range: ${v}`);
    this.chunks.push(v);
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  u32(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`u32 out of range: ${v}`);
    this.chunks.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }

  u64(v: bigint): this {
    if (v < 0n || v >= 1n << 64n) throw new Error(`u64 out of range: ${v}`);
    let x = v;
    for (let i = 0; i < 8; i++) {
      this.chunks.push(Number(x & 0xffn));
      x >>= 8n;
    }
    return this;
  }

  bytes(b: Uint8Array): this {
    this.u32(b.length);
    for (const byte of b) this.chunks.push(byte);
    return this;
  }

  string(s: string): this {
    return this.bytes(new TextEncoder().encode(s));
  }

  optionalString(s: string | undefined | null): this {
    if (s === undefined || s === null || s === "") return this.u8(0);
    return this.u8(1).string(s);
  }

  optionalU8(v: number | undefined): this {
    if (v === undefined) return this.u8(0);
    return this.u8(1).u8(v);
  }

  u8Array(values: readonly number[]): this {
    this.u32(values.length);
    for (const v of values) this.u8(v);
    return this;
  }

  stringArray(values: readonly string[]): this {
    this.u32(values.length);
    for (const v of values) this.string(v);
    return this;
  }

  domain(s: string): this {
    return this.string(s);
  }

  finish(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

/** Incremental reader mirroring CanonicalWriter. Bounds-checked throughout. */
export class CanonicalReader {
  private view: Uint8Array;
  private pos = 0;

  constructor(data: Uint8Array) {
    this.view = data;
  }

  private take(n: number): Uint8Array {
    if (this.pos + n > this.view.length) throw new Error("canonical decode: unexpected end");
    const out = this.view.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  bool(): boolean {
    return this.u8() === 1;
  }

  u32(): number {
    const b = this.take(4);
    return b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24);
  }

  u64(): bigint {
    let v = 0n;
    const b = this.take(8);
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
  }

  bytes(): Uint8Array {
    return this.take(this.u32());
  }

  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  optionalString(): string | undefined {
    if (this.u8() === 0) return undefined;
    return this.string();
  }

  optionalU8(): number | undefined {
    if (this.u8() === 0) return undefined;
    return this.u8();
  }

  u8Array(): number[] {
    const n = this.u32();
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.u8());
    return out;
  }

  stringArray(): string[] {
    const n = this.u32();
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(this.string());
    return out;
  }

  eof(): boolean {
    return this.pos === this.view.length;
  }
}
