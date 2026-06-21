/** bytes <-> hex helpers (payload_hex, signatures, content ids). Runtime-agnostic. */

const HEX_CHARS = "0123456789abcdef";

/** Encode bytes to a lowercase hex string. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX_CHARS[b >> 4]! + HEX_CHARS[b & 0x0f]!;
  }
  return out;
}

/** Decode a hex string (case-insensitive, optional `0x` prefix) to bytes. */
export function fromHex(hex: string): Uint8Array {
  let s = hex.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
  if (s.length % 2 !== 0) {
    throw new RangeError(`hex string has odd length: ${s.length}`);
  }
  if (s.length > 0 && !/^[0-9a-fA-F]+$/.test(s)) {
    throw new RangeError("hex string contains non-hex characters");
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** UTF-8 encode a string to bytes. */
export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** UTF-8 decode bytes to a string. */
export function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
