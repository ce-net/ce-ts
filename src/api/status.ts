/** Status / discovery endpoints: health, status, bootstrap, beacon, atlas. */

import { Amount } from "../amount.js";
import type { Transport } from "../transport.js";
import type {
  AtlasEntry,
  Beacon,
  Bootstrap,
  NodeStatus,
  RawAtlasEntry,
  RawBeacon,
  RawBootstrap,
  RawNodeStatus,
} from "../types.js";

function amt(s: string | undefined | null): Amount {
  return s == null ? Amount.ZERO : Amount.fromBaseUnits(s);
}

export function toNodeStatus(r: RawNodeStatus): NodeStatus {
  return {
    nodeId: r.node_id,
    height: r.height,
    difficulty: r.difficulty ?? 0,
    balance: amt(r.balance),
    circulatingSupply: amt(r.circulating_supply),
    burnedTotal: amt(r.burned_total),
    bond: amt(r.bond),
    weight: r.weight ?? 0,
    free: amt(r.free),
    lockedChannels: amt(r.locked_channels),
    lockedBond: amt(r.locked_bond),
  };
}

export function toAtlasEntry(r: RawAtlasEntry): AtlasEntry {
  return {
    nodeId: r.node_id,
    cpuCores: r.cpu_cores,
    memMb: r.mem_mb,
    runningJobs: r.running_jobs,
    lastSeenSecs: r.last_seen_secs,
    tags: r.tags ?? [],
  };
}

export class StatusApi {
  constructor(private readonly t: Transport) {}

  /** `GET /health` → `true` when the node is live. */
  async health(): Promise<boolean> {
    try {
      const body = await this.t.request<string>("GET", "/health", "text", {
        auth: false,
        maxRetries: 0,
      });
      return body.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** `GET /status` → full node state snapshot. */
  async status(): Promise<NodeStatus> {
    const r = await this.t.request<RawNodeStatus>("GET", "/status", "json", {
      auth: false,
    });
    return toNodeStatus(r);
  }

  /** `GET /bootstrap` → advertised multiaddrs. */
  async bootstrap(): Promise<Bootstrap> {
    const r = await this.t.request<RawBootstrap>("GET", "/bootstrap", "json", {
      auth: false,
    });
    return { peers: r.peers ?? [] };
  }

  /** `GET /beacon` → PoW tip (verifiable randomness). */
  async beacon(): Promise<Beacon> {
    const r = await this.t.request<RawBeacon>("GET", "/beacon", "json", {
      auth: false,
    });
    return { height: r.height, hash: r.hash };
  }

  /** `GET /atlas` → peer capacity snapshot. */
  async atlas(): Promise<AtlasEntry[]> {
    const r = await this.t.request<RawAtlasEntry[]>("GET", "/atlas", "json", {
      auth: false,
    });
    return (r ?? []).map(toAtlasEntry);
  }
}
