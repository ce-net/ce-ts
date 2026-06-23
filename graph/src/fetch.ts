/**
 * Fetching measured edges (and optional capacity) from one or more CE nodes.
 *
 * Runtime-agnostic: uses only the web-standard `fetch` / `AbortController`, so it runs
 * unchanged on Node 20+, Deno, Bun, browsers, and edge Workers — matching `@ce-net/sdk`.
 *
 * @packageDocumentation
 */

import type {
  MeasuredObservation,
  NodeCapacity,
  RawAtlasEntry,
  RawNetGraphEdge,
} from "./types.js";

/** Options for {@link fetchNetGraph}. */
export interface FetchOptions {
  /** Per-request timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** Inject a custom fetch (tests, auth wrappers). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Also pull `GET /atlas` from each node and fold capacity in. Default false — the query
   * contract is pure topology, capacity is an optional enrichment.
   */
  includeAtlas?: boolean;
  /** Extra headers (e.g. an API token) sent on every request. */
  headers?: Record<string, string>;
}

/** The combined result of scraping a set of nodes once. */
export interface FetchResult {
  /** All directed observations gathered (origin = the node URL key that served them). */
  observations: MeasuredObservation[];
  /** Capacity per node, keyed by node_id — empty unless `includeAtlas` was set. */
  capacity: NodeCapacity[];
  /** URLs that failed to respond, with the reason — assembly proceeds without them. */
  failures: { url: string; reason: string }[];
}

function joinUrl(base: string, path: string): string {
  return base.endsWith("/") ? base.slice(0, -1) + path : base + path;
}

async function getJson<T>(
  url: string,
  opts: Required<Pick<FetchOptions, "timeoutMs" | "fetch">> &
    Pick<FetchOptions, "headers">,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const res = await opts.fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...(opts.headers ?? {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the measured network graph from one or more nodes.
 *
 * Each node reports edges from *its own* vantage point, so the `origin` of every observation
 * is set to that node's URL key. Folding several vantage points together (e.g. both endpoints
 * of a link) is what {@link MeasuredGraph} fuses into undirected edges. Querying more nodes
 * yields a denser, more accurate graph; a single node still produces a usable star of its
 * direct links.
 *
 * Per-node failures are collected, not thrown: one unreachable node never aborts the assembly.
 */
export async function fetchNetGraph(
  nodeUrls: string[],
  options: FetchOptions = {},
): Promise<FetchResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("no fetch implementation available; pass options.fetch");
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  const headers = options.headers;

  const observations: MeasuredObservation[] = [];
  const capacityByNode = new Map<string, NodeCapacity>();
  const failures: { url: string; reason: string }[] = [];

  await Promise.all(
    nodeUrls.map(async (url) => {
      const origin = url;
      try {
        const edges = await getJson<RawNetGraphEdge[]>(
          joinUrl(url, "/netgraph"),
          { timeoutMs, fetch: fetchImpl, headers },
        );
        for (const e of edges) {
          observations.push({
            origin,
            peer: e.peer,
            rttMs: e.rtt_ms,
            samples: e.samples,
            lastSeenSecs: e.last_seen_secs,
          });
        }
      } catch (err) {
        failures.push({ url, reason: errMessage(err) });
        return;
      }

      if (options.includeAtlas) {
        try {
          const atlas = await getJson<RawAtlasEntry[]>(
            joinUrl(url, "/atlas"),
            { timeoutMs, fetch: fetchImpl, headers },
          );
          for (const a of atlas) {
            // Keep the freshest capacity record if several nodes report the same peer.
            const prev = capacityByNode.get(a.node_id);
            if (!prev || a.last_seen_secs >= prev.lastSeenSecs) {
              capacityByNode.set(a.node_id, {
                nodeId: a.node_id,
                cpuCores: a.cpu_cores,
                memMb: a.mem_mb,
                runningJobs: a.running_jobs,
                lastSeenSecs: a.last_seen_secs,
                tags: a.tags ?? [],
              });
            }
          }
        } catch (err) {
          // Atlas is optional enrichment; record the failure but keep the topology.
          failures.push({ url: joinUrl(url, "/atlas"), reason: errMessage(err) });
        }
      }
    }),
  );

  return {
    observations,
    capacity: [...capacityByNode.values()],
    failures,
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
