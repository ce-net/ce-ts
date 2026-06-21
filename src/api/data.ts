/**
 * Data layer: blobs, objects (chunk/reassemble), paid chunk fetch.
 *
 * Pure helpers (`cid`, `chunkObject`, `reassemble`) mirror ce-rs `data`, runtime-agnostic
 * via `crypto.subtle.digest('SHA-256')`. NOTE: `cid()` is **async** here (Web SubtleCrypto
 * is async) — a deliberate, documented difference from ce-rs's sync `cid()`.
 */

import { Amount } from "../amount.js";
import { toHex } from "../hex.js";
import { CeError } from "../errors.js";
import type { Transport } from "../transport.js";
import type { Manifest, RawManifest } from "../types.js";

/** Default chunk size: 1 MiB (matches ce-rs `DEFAULT_CHUNK_SIZE`). */
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

/** SHA-256 content id (lowercase hex). Matches the node's `/blobs` keying. Async. */
export async function cid(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new CeError("crypto.subtle is unavailable in this runtime");
  }
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await subtle.digest("SHA-256", buf);
  return toHex(new Uint8Array(digest));
}

/** Split bytes into chunks; return a manifest + `(cid, chunkBytes)` pairs. */
export async function chunkObject(
  bytes: Uint8Array,
  size: number = DEFAULT_CHUNK_SIZE,
): Promise<{ manifest: Manifest; chunks: [string, Uint8Array][] }> {
  const chunks: [string, Uint8Array][] = [];
  const cids: string[] = [];
  for (let off = 0; off < bytes.length || (off === 0 && bytes.length === 0); off += size) {
    const slice = bytes.subarray(off, Math.min(off + size, bytes.length));
    const c = await cid(slice);
    chunks.push([c, slice]);
    cids.push(c);
    if (bytes.length === 0) break;
  }
  const manifest: Manifest = {
    kind: "ce-object-v1",
    chunkSize: size,
    totalSize: bytes.length,
    chunks: cids,
  };
  return { manifest, chunks };
}

/** Reassemble an object from its manifest, verifying each chunk against its CID. */
export async function reassemble(
  manifest: Manifest,
  fetchChunk: (cid: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const out = new Uint8Array(manifest.totalSize);
  let off = 0;
  for (const c of manifest.chunks) {
    const bytes = await fetchChunk(c);
    const got = await cid(bytes);
    if (got !== c) {
      throw new CeError(`chunk hash mismatch: expected ${c}, got ${got}`);
    }
    out.set(bytes, off);
    off += bytes.length;
  }
  if (off !== manifest.totalSize) {
    throw new CeError(
      `reassembled size ${off} != manifest total ${manifest.totalSize}`,
    );
  }
  return out;
}

function manifestToWire(m: Manifest): RawManifest {
  return {
    kind: m.kind,
    chunk_size: m.chunkSize,
    total_size: m.totalSize,
    chunks: m.chunks,
  };
}

function wireToManifest(r: RawManifest): Manifest {
  return {
    kind: "ce-object-v1",
    chunkSize: r.chunk_size,
    totalSize: r.total_size,
    chunks: r.chunks ?? [],
  };
}

function isManifestJson(bytes: Uint8Array): RawManifest | null {
  try {
    const txt = new TextDecoder().decode(bytes);
    const j = JSON.parse(txt) as RawManifest;
    if (j && j.kind === "ce-object-v1" && Array.isArray(j.chunks)) return j;
    return null;
  } catch {
    return null;
  }
}

export class DataApi {
  constructor(private readonly t: Transport) {}

  /** `POST /blobs` (raw binary) → 64-hex sha256 hash. */
  async putBlob(bytes: Uint8Array): Promise<string> {
    const r = await this.t.request<{ hash: string }>("POST", "/blobs", "json", {
      rawBody: bytes,
      idempotent: true,
    });
    return r.hash;
  }

  /** `GET /blobs/:hash` → blob bytes. */
  async getBlob(hash: string): Promise<Uint8Array> {
    return this.t.request<Uint8Array>(
      "GET",
      `/blobs/${encodeURIComponent(hash)}`,
      "bytes",
      { auth: false },
    );
  }

  /**
   * Upload an object of any size: split into chunks, store each as a blob, then store
   * the manifest. Returns the object CID (the manifest's blob hash).
   */
  async putObject(bytes: Uint8Array, size: number = DEFAULT_CHUNK_SIZE): Promise<string> {
    const { manifest, chunks } = await chunkObject(bytes, size);
    for (const [, chunkBytes] of chunks) {
      await this.putBlob(chunkBytes);
    }
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestToWire(manifest)));
    return this.putBlob(manifestBytes);
  }

  /** Fetch an object by CID: resolve manifest, pull+verify chunks, reassemble. */
  async getObject(cidStr: string): Promise<Uint8Array> {
    const manifestBytes = await this.getBlob(cidStr);
    const raw = isManifestJson(manifestBytes);
    if (!raw) {
      // Not a manifest — treat the CID as a plain blob.
      return manifestBytes;
    }
    const manifest = wireToManifest(raw);
    return reassemble(manifest, (c) => this.getBlob(c));
  }

  /** `POST /data/fetch` → paid chunk fetch over the mesh; verified against `cid`. */
  async fetchChunkPaid(
    provider: string,
    cidStr: string,
    channelId: string,
    cumulative: Amount,
  ): Promise<Uint8Array> {
    return this.t.request<Uint8Array>("POST", "/data/fetch", "bytes", {
      body: {
        provider,
        cid: cidStr,
        channel_id: channelId,
        cumulative: cumulative.toBaseUnits(),
      },
    });
  }
}
