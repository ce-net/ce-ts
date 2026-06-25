/**
 * Mesh-native service location + selection — the other half of building a real mesh app.
 *
 * {@link serve} lets a TS app *be* a service (answer requests on a topic). This module lets a
 * client *find and pick* a live instance of a service over the mesh, so the SDK never
 * hardcodes a NodeId or talks to a central HTTP endpoint. It ports `ce_rs::locate`: it
 * composes only existing node primitives — DHT service discovery (`ce.discovery.find`), the
 * capacity atlas (`ce.atlas()`), per-node reputation (`ce.history()`), and the verifiable
 * randomness beacon (`ce.beacon()`) — so there are no new node RPCs and nothing is routed off
 * the mesh.
 *
 * ## Selection
 *
 * {@link locate} discovers the instances advertising a service, then ranks the live ones by
 * **trust** (on-chain delivered-and-paid work), **capacity** (free cores/memory), and
 * **recency**, with a **beacon-seeded** deterministic tiebreak so the choice is reproducible
 * and unsteerable. When more than one instance is requested for redundancy, candidates are
 * **spread across distinct fault domains** (region / zone / asn tags) so one datacenter or
 * operator loss does not take them all.
 *
 * @example
 * ```ts
 * import { CeClient, call } from "@ce-net/sdk";
 * const ce = CeClient.local();
 * // Find a live "ce-db" instance and request it over the mesh, failing over to the next best.
 * const reply = await call(ce, "ce-db", "ce-db/rpc", new TextEncoder().encode("get:user:42"));
 * ```
 *
 * @packageDocumentation
 */

import type { CeClient } from "./client.js";
import type { AtlasEntry } from "./types.js";

/** A located, live instance of a service, with the signals used to rank it. */
export interface Instance {
  /** The instance's NodeId (hex). */
  readonly nodeId: string;
  /** Composite selection score (higher is better). */
  readonly score: number;
  /** Advertised CPU cores. */
  readonly cores: number;
  /** Advertised memory (MiB). */
  readonly memMb: number;
  /** The node's capability self-tags. */
  readonly tags: string[];
  /** Unix seconds since this node was last seen in the atlas. */
  readonly lastSeenSecs: number;
  /** The fault domain (region:/zone:/asn: tag) used for redundancy spread, if any. */
  readonly faultDomain: string | null;
}

/** How to select instances. Mirrors `ce_rs::locate::LocateOpts`. */
export interface LocateOpts {
  /** How many instances to return (redundancy). Default 1. */
  want?: number;
  /** Only consider instances whose atlas tags include all of these. */
  requireTags?: string[];
  /** Consider an instance live only if seen within this many seconds. Default 120. */
  maxStaleSecs?: number;
  /** When `want > 1`, spread the chosen instances across distinct fault domains. Default true. */
  spreadDomains?: boolean;
  /**
   * "Now" override in unix seconds, for deterministic testing of recency/staleness. Defaults
   * to `Date.now()/1000`.
   */
  now?: number;
}

interface ResolvedOpts {
  want: number;
  requireTags: string[];
  maxStaleSecs: number;
  spreadDomains: boolean;
  now: number;
}

function resolve(opts: LocateOpts): ResolvedOpts {
  return {
    want: opts.want ?? 1,
    requireTags: opts.requireTags ?? [],
    maxStaleSecs: opts.maxStaleSecs ?? 120,
    spreadDomains: opts.spreadDomains ?? true,
    now: opts.now ?? Math.floor(Date.now() / 1000),
  };
}

/**
 * Discover and rank live instances of `service`, best first.
 *
 * Returns at most `opts.want` instances. An empty array means the service is advertised by no
 * live instance matching the constraints (the caller decides whether to start one).
 */
export async function locate(
  ce: CeClient,
  service: string,
  opts: LocateOpts = {},
): Promise<Instance[]> {
  const o = resolve(opts);

  const ids = await ce.discovery.find(service);
  if (ids.length === 0) return [];

  const atlas = await ce.atlas();
  // Beacon seeds a deterministic, unsteerable tiebreak; tolerate its absence.
  let beaconHash = "";
  try {
    beaconHash = (await ce.beacon()).hash;
  } catch {
    beaconHash = "";
  }

  // Index the atlas by node id for O(1) lookup.
  const byId = new Map<string, AtlasEntry>();
  for (const e of atlas) byId.set(e.nodeId, e);

  const scored: Instance[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) continue; // not in atlas -> unknown/dead

    // Liveness: drop stale advertisements.
    const age = Math.max(0, o.now - entry.lastSeenSecs);
    if (age > o.maxStaleSecs) continue;

    // Required capability tags.
    if (!o.requireTags.every((t) => entry.tags.includes(t))) continue;

    // Trust: on-chain delivered-and-paid work, log-saturated; a stranger scores 0.
    // Best-effort (a history read failure degrades trust to 0 rather than dropping it).
    let trust = 0;
    try {
      const h = await ce.history(id);
      if (!h.isNewcomer()) {
        const delivered = h.jobsPaid + h.heartbeatsPaid;
        trust = Math.log(1 + delivered);
      }
    } catch {
      trust = 0;
    }
    const trustNorm = Math.min(trust / 10.0, 1.0); // ~22k delivered units saturates

    // Capacity headroom (rough): free cores (total minus running jobs) + memory, normalized.
    const freeCores = Math.max(0, entry.cpuCores - entry.runningJobs);
    const cap =
      Math.min(freeCores / 16.0, 1.0) * 0.5 +
      Math.min(entry.memMb / 32_768.0, 1.0) * 0.5;

    // Recency: 1.0 when just seen, decaying to 0 across the staleness window.
    const recency = 1.0 - age / Math.max(o.maxStaleSecs, 1);

    // Deterministic, beacon-seeded jitter for reproducible tiebreaks nobody can steer.
    const jitter = await beaconJitter(id, beaconHash);

    const score = 0.5 * trustNorm + 0.3 * cap + 0.2 * recency + 0.001 * jitter;
    scored.push({
      nodeId: id,
      score,
      cores: entry.cpuCores,
      memMb: entry.memMb,
      tags: [...entry.tags],
      lastSeenSecs: entry.lastSeenSecs,
      faultDomain: faultDomain(entry.tags),
    });
  }

  scored.sort((a, b) => b.score - a.score);

  const want = Math.max(o.want, 1);
  if (want === 1 || !o.spreadDomains) {
    return scored.slice(0, want);
  }
  return spread(scored, want);
}

/** Options for {@link call}. */
export interface CallOpts extends LocateOpts {
  /** Per-request mesh timeout in ms passed to `ce.mesh.request`. Default 5000. */
  timeoutMs?: number;
}

/**
 * Locate the best instance(s) of `service` and send `payload` to one over the mesh on
 * `topic`, failing over to the next-best instance if a request errors. Returns the first
 * successful reply.
 */
export async function call(
  ce: CeClient,
  service: string,
  topic: string,
  payload: Uint8Array,
  opts: CallOpts = {},
): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  // Locate a few candidates so we can fail over, regardless of how many the caller wants.
  const o: LocateOpts = { ...opts, want: Math.max(opts.want ?? 1, 3) };
  const instances = await locate(ce, service, o);
  if (instances.length === 0) {
    throw new Error(`no live instance of service '${service}' found`);
  }
  let lastErr: unknown;
  for (const inst of instances) {
    try {
      return await ce.mesh.request(inst.nodeId, topic, payload, timeoutMs);
    } catch (err) {
      lastErr = err;
      // fall through to the next-best instance
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`all instances of '${service}' failed`);
}

/**
 * Keep this node discoverable as an instance of `service`: re-advertise on the DHT every
 * `intervalMs` until `signal` aborts. A service built with {@link serve} calls this so
 * clients can {@link locate} it. DHT provider records expire, so periodic re-advertisement is
 * the liveness signal. Advertise failures are swallowed (logged via `onWarn`) and retried.
 */
export async function register(
  ce: CeClient,
  service: string,
  intervalMs: number,
  opts: { signal?: AbortSignal; onWarn?: (m: string, d?: unknown) => void } = {},
): Promise<void> {
  const warn = opts.onWarn ?? (() => {});
  const signal = opts.signal;
  while (!signal?.aborted) {
    try {
      await ce.discovery.advertise(service);
    } catch (err) {
      warn("register: advertise failed; will retry", err);
    }
    await sleep(intervalMs, signal);
  }
}

// ---- ranking helpers (ported 1:1 from ce_rs::locate) ----

/** The fault domain for redundancy spread: the first of region:/zone:/asn: tags, if present. */
export function faultDomain(tags: readonly string[]): string | null {
  for (const prefix of ["region:", "zone:", "asn:"]) {
    const t = tags.find((x) => x.startsWith(prefix));
    if (t !== undefined) return t;
  }
  return null;
}

/**
 * Pick `want` instances spreading across distinct fault domains first (one best-scored per
 * domain, round-robin), then fill any remainder by score. Instances with an unknown domain are
 * each their own bucket so they are never blindly collapsed together.
 */
export function spread(scored: Instance[], want: number): Instance[] {
  // Group by domain, preserving score order within each group.
  const groups = new Map<string, Instance[]>();
  scored.forEach((inst, i) => {
    // Unknown domain -> a unique bucket per instance (keyed by its index).
    const key = inst.faultDomain ?? `~${i}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(inst);
    else groups.set(key, [inst]);
  });

  // Order buckets by their best instance's score so we round-robin best-first.
  const buckets = [...groups.values()].sort((a, b) => {
    const sa = a[0]?.score ?? -Infinity;
    const sb = b[0]?.score ?? -Infinity;
    return sb - sa;
  });

  const out: Instance[] = [];
  let round = 0;
  for (;;) {
    let tookAny = false;
    for (const bucket of buckets) {
      if (out.length >= want) return out;
      const item = bucket[round];
      if (item !== undefined) {
        out.push(item);
        tookAny = true;
      }
    }
    if (!tookAny) return out; // exhausted all buckets
    round++;
  }
}

/**
 * A deterministic [0,1) value derived from the node id and the beacon hash — a tiebreak no
 * party can predict before the beacon is fixed or steer afterward. Uses SHA-256 over
 * `nodeId | beaconHash`, taking the first 8 bytes as a big-endian u64 normalized to [0,1).
 */
export async function beaconJitter(
  nodeId: string,
  beaconHash: string,
): Promise<number> {
  const data = utf8(`${nodeId}|${beaconHash}`);
  const digest = new Uint8Array(await sha256(data));
  // First 8 bytes, big-endian, as a float in [0,1). Float64 has 52 mantissa bits, so the
  // top 53 bits of the u64 determine the value; exact equality of the Rust f64 is not
  // required — only determinism and bounds, which this preserves.
  let n = 0;
  for (let i = 0; i < 8; i++) n = n * 256 + digest[i]!;
  // 2^64 as a float constant.
  return n / 18_446_744_073_709_551_616;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function sha256(data: Uint8Array): Promise<ArrayBuffer> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "locate: WebCrypto subtle.digest unavailable; required for beacon-seeded tiebreak",
    );
  }
  // Copy into a fresh ArrayBuffer-backed view to satisfy BufferSource typing across runtimes.
  const buf = new Uint8Array(data.byteLength);
  buf.set(data);
  return subtle.digest("SHA-256", buf);
}

/** Sleep `ms`, resolving early (without throwing) if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
