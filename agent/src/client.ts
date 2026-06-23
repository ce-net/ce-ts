/**
 * CeClient — a thin, structured client over the CE node HTTP API (+ the hub for fabric stats).
 * Every method returns a `Result`: either `{ ok: true, data }` or `{ ok: false, error: CeFault }`.
 * It never throws on an expected failure — agents get a typed fault with a fix-it hint instead of a
 * stack trace. Runtime-agnostic (web-standard fetch only).
 */

import { faultFromHttp, faultFromThrow, type CeFault } from "./errors.js";

export type Result<T> = { ok: true; data: T } | { ok: false; error: CeFault };

export interface CeClientOptions {
  /** Node HTTP API base, default http://localhost:8844. */
  nodeUrl?: string;
  /** Hub base for aggregate fabric stats, e.g. https://ce-net.com/hub. Optional. */
  hubUrl?: string;
  /** Node API token (for non-loopback or protected nodes). */
  token?: string;
  /** Per-request timeout, default 15000ms. */
  timeoutMs?: number;
  /** Injected fetch (for tests / non-browser runtimes that need a polyfill). */
  fetch?: typeof fetch;
}

export interface NodeStatus {
  node_id: string;
  height: number;
  balance: string;
  peers?: number;
}

export interface AtlasEntry {
  node_id: string;
  cpu_cores: number;
  mem_mb: number;
  running_jobs: number;
  last_seen_secs: number;
  tags: string[];
}

export interface NetGraphEdge {
  peer: string;
  rtt_ms: number;
  samples: number;
  last_seen_secs: number;
}

export interface Job {
  job_id: string;
  status: string;
  [k: string]: unknown;
}

export interface FabricStats {
  nodes: number;
  cpu_cores: number;
  gpu_count: number;
  gpu_vram_gb: number;
  ram_gb: number;
  storage_gb: number;
  perf_score: number;
  /** Network-health from the local node's measured edges. */
  mesh: { peers: number; median_rtt_ms: number | null };
}

export interface DeploySpec {
  /** Container image (mutually exclusive with wasmModule). */
  image?: string;
  /** WASM module CID (64-hex). */
  wasmModule?: string;
  cmd?: string[];
  cpuCores?: number;
  memMb?: number;
  durationSecs?: number;
  /** Bid in credits (decimal string). */
  bid?: string;
  /** Target host node id; omit to broadcast a bid. */
  host?: string;
  /** Validate only — do not actually deploy. */
  dryRun?: boolean;
}

export class CeClient {
  readonly nodeUrl: string;
  readonly hubUrl?: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly _fetch: typeof fetch;

  constructor(opts: CeClientOptions = {}) {
    this.nodeUrl = (opts.nodeUrl ?? "http://localhost:8844").replace(/\/$/, "");
    this.hubUrl = opts.hubUrl?.replace(/\/$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this._fetch = opts.fetch ?? globalThis.fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await this._fetch(`${this.nodeUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: faultFromHttp(res.status, text) };
      // Tolerate non-JSON bodies (e.g. /health returns plain "ok"): parse if we can, else pass raw.
      let data: unknown = text || undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { ok: true, data: data as T };
    } catch (e) {
      return { ok: false, error: faultFromThrow(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  status() {
    return this.req<NodeStatus>("GET", "/status");
  }
  health() {
    return this.req<unknown>("GET", "/health");
  }
  atlas() {
    return this.req<AtlasEntry[]>("GET", "/atlas");
  }
  netgraph() {
    return this.req<NetGraphEdge[]>("GET", "/netgraph");
  }
  jobs() {
    return this.req<Job[]>("GET", "/jobs");
  }
  job(id: string) {
    return this.req<Job>("GET", `/jobs/${id}`);
  }
  kill(id: string) {
    return this.req<unknown>("DELETE", `/jobs/${id}`);
  }
  transfer(to: string, amount: string) {
    return this.req<unknown>("POST", "/transfer", { to, amount });
  }

  /** Deploy a workload. Directed (`host`) uses /mesh-deploy; otherwise broadcasts a /jobs/bid. */
  deploy(spec: DeploySpec): Promise<Result<{ job_id: string }>> {
    if (spec.dryRun) {
      // Local validation only — surfaces obvious mistakes before spending anything.
      if (!spec.image && !spec.wasmModule) {
        return Promise.resolve({
          ok: false,
          error: faultFromHttp(400, "deploy needs either image or wasmModule"),
        });
      }
      return Promise.resolve({ ok: true, data: { job_id: "(dry-run: validation passed)" } });
    }
    const payload = {
      image: spec.image,
      wasm_module: spec.wasmModule,
      cmd: spec.cmd ?? [],
      cpu_cores: spec.cpuCores ?? 1,
      mem_mb: spec.memMb ?? 256,
      duration_secs: spec.durationSecs ?? 3600,
      bid: spec.bid ?? "1",
    };
    return spec.host
      ? this.req<{ job_id: string }>("POST", "/mesh-deploy", { ...payload, host: spec.host })
      : this.req<{ job_id: string }>("POST", "/jobs/bid", payload);
  }

  /** Aggregate fabric stats: prefer the hub scoreboard, fall back to the local atlas + netgraph. */
  async fabricStats(): Promise<Result<FabricStats>> {
    if (this.hubUrl) {
      try {
        const res = await this._fetch(`${this.hubUrl}/stats`, { headers: { accept: "application/json" } });
        if (res.ok) {
          const s = (await res.json()) as Record<string, number>;
          return {
            ok: true,
            data: {
              nodes: s.nodes ?? 0,
              cpu_cores: s.cores ?? 0,
              gpu_count: s.gpu_count ?? 0,
              gpu_vram_gb: s.gpu_vram_gb ?? 0,
              ram_gb: s.ram_gb ?? 0,
              storage_gb: s.storage_gb ?? 0,
              perf_score: s.perf_score ?? 0,
              mesh: { peers: 0, median_rtt_ms: null },
            },
          };
        }
      } catch {
        /* fall through to local */
      }
    }
    const atlas = await this.atlas();
    if (!atlas.ok) return atlas;
    const net = await this.netgraph();
    const rtts = net.ok ? net.data.map((e) => e.rtt_ms).sort((a, b) => a - b) : [];
    const median = rtts.length ? rtts[Math.floor(rtts.length / 2)] : null;
    const cores = atlas.data.reduce((a, n) => a + (n.cpu_cores || 0), 0);
    return {
      ok: true,
      data: {
        nodes: atlas.data.length,
        cpu_cores: cores,
        gpu_count: atlas.data.filter((n) => n.tags.includes("gpu")).length,
        gpu_vram_gb: 0,
        ram_gb: Math.round(atlas.data.reduce((a, n) => a + (n.mem_mb || 0), 0) / 1024),
        storage_gb: 0,
        perf_score: 0,
        mesh: { peers: net.ok ? net.data.length : 0, median_rtt_ms: median },
      },
    };
  }
}
