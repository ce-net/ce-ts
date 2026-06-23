/**
 * A minimal bincode v1 codec, matching the Rust `bincode = "1"` default configuration used by the
 * `ce-cap` crate. The exact rules this implements (verified against the Rust crate):
 *
 *   - **Integers are fixint, little-endian.** No varint. `u64`/`i64` are 8 bytes, `u32` 4 bytes,
 *     `u16` 2 bytes, `u8` 1 byte.
 *   - **Sequence/length prefixes are `u64` little-endian.** `Vec<T>` and `String` are prefixed with
 *     their element/byte length as a u64, then the elements/UTF-8 bytes.
 *   - **`serialize_bytes` (`&[u8]`, `serde_bytes`) is `u64` length + raw bytes.** This is how the
 *     `b"ce-cap-v1"` domain tag and the 64-byte signature are written.
 *   - **Fixed-size arrays (`[u8; 32]`) are NOT length-prefixed.** serde encodes arrays as tuples,
 *     so a `NodeId`/`CapId` is exactly 32 raw bytes with no prefix.
 *   - **Enums use a `u32` little-endian variant index tag**, followed by the variant's fields.
 *   - **`Option<T>` is a single byte: `0x00` for `None`, `0x01` followed by `T` for `Some`.**
 *   - **Tuples and structs are their fields concatenated in declaration order**, no prefix.
 *
 * This file is the single source of truth for wire compatibility; everything in `index.ts` composes
 * these primitives. The golden-vector test pins the result byte-for-byte against the Rust output.
 */

/** Grows an internal byte buffer, exposing little-endian fixint and length-prefixed writers. */
export class BincodeWriter {
  private buf: number[] = [];

  /** Append raw bytes verbatim (no prefix). */
  writeRaw(bytes: Uint8Array): void {
    for (const b of bytes) this.buf.push(b);
  }

  /** u8. */
  writeU8(v: number): void {
    this.buf.push(v & 0xff);
  }

  /** u16, little-endian. */
  writeU16(v: number): void {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff);
  }

  /** u32, little-endian. */
  writeU32(v: number): void {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }

  /** u64, little-endian (accepts bigint to cover the full range). */
  writeU64(v: bigint): void {
    let x = BigInt.asUintN(64, v);
    for (let i = 0; i < 8; i++) {
      this.buf.push(Number(x & 0xffn));
      x >>= 8n;
    }
  }

  /** A bincode `serialize_bytes`: u64 length prefix + raw bytes. */
  writeBytes(bytes: Uint8Array): void {
    this.writeU64(BigInt(bytes.length));
    this.writeRaw(bytes);
  }

  /** A bincode `String`: u64 byte-length prefix + UTF-8 bytes. */
  writeString(s: string): void {
    this.writeBytes(new TextEncoder().encode(s));
  }

  /** A fixed-size byte array (`[u8; N]`): raw bytes, no prefix. Caller guarantees length. */
  writeFixedBytes(bytes: Uint8Array): void {
    this.writeRaw(bytes);
  }

  /** An enum variant tag: u32 little-endian index. */
  writeEnumTag(index: number): void {
    this.writeU32(index);
  }

  /** An `Option` discriminant byte (call before writing the `Some` payload). */
  writeOptionTag(present: boolean): void {
    this.buf.push(present ? 1 : 0);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

/** Sequentially reads the primitives written by {@link BincodeWriter}. */
export class BincodeReader {
  private offset = 0;
  constructor(private readonly data: Uint8Array) {}

  /** Whether all bytes have been consumed. */
  get done(): boolean {
    return this.offset >= this.data.length;
  }

  /** Number of bytes consumed so far. */
  get position(): number {
    return this.offset;
  }

  private take(n: number): Uint8Array {
    if (this.offset + n > this.data.length) {
      throw new Error(`bincode: unexpected end of input (need ${n} at ${this.offset})`);
    }
    const slice = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  readU8(): number {
    return this.take(1)[0]!;
  }

  readU16(): number {
    const b = this.take(2);
    return b[0]! | (b[1]! << 8);
  }

  readU32(): number {
    const b = this.take(4);
    // `>>> 0` keeps the result an unsigned 32-bit integer.
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  readU64(): bigint {
    const b = this.take(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
  }

  /** Read `serialize_bytes`: u64 length prefix + that many bytes. */
  readBytes(): Uint8Array {
    const len = Number(this.readU64());
    return this.take(len);
  }

  /** Read a bincode `String`. */
  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }

  /** Read a fixed-size byte array of length `n` (no prefix). */
  readFixedBytes(n: number): Uint8Array {
    // Copy so callers own a standalone buffer rather than a view into `data`.
    return Uint8Array.from(this.take(n));
  }

  /** Read an enum variant tag (u32). */
  readEnumTag(): number {
    return this.readU32();
  }

  /** Read an `Option` discriminant byte; returns true for `Some`. */
  readOptionTag(): boolean {
    const tag = this.readU8();
    if (tag !== 0 && tag !== 1) throw new Error(`bincode: invalid Option tag ${tag}`);
    return tag === 1;
  }
}

/** Lowercase hex of a byte array. */
export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Parse a lowercase/uppercase hex string into bytes. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}
