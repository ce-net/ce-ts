import { describe, it, expect } from "vitest";
import {
  locate,
  call,
  spread,
  faultDomain,
  beaconJitter,
  type Instance,
} from "../src/locate.js";
import type { CeClient } from "../src/client.js";
import type { AtlasEntry, Beacon, NodeHistory } from "../src/types.js";
import { Amount } from "../src/amount.js";

function atlasEntry(p: Partial<AtlasEntry> & { nodeId: string }): AtlasEntry {
  return {
    nodeId: p.nodeId,
    cpuCores: p.cpuCores ?? 8,
    memMb: p.memMb ?? 16_384,
    runningJobs: p.runningJobs ?? 0,
    lastSeenSecs: p.lastSeenSecs ?? 1000,
    tags: p.tags ?? [],
  };
}

function history(p: Partial<NodeHistory> & { nodeId: string }): NodeHistory {
  const firstHeight = p.firstHeight ?? 1;
  const jobsPaid = p.jobsPaid ?? 0;
  const heartbeatsPaid = p.heartbeatsPaid ?? 0;
  return {
    nodeId: p.nodeId,
    jobsHosted: p.jobsHosted ?? 0,
    jobsPaid,
    heartbeatsHosted: p.heartbeatsHosted ?? 0,
    heartbeatsPaid,
    expiries: 0,
    earned: Amount.ZERO,
    spent: Amount.ZERO,
    firstHeight,
    lastHeight: p.lastHeight ?? 10,
    isNewcomer: () => firstHeight === 0,
    deliveredWork: () => (p.jobsHosted ?? 0) + (p.heartbeatsHosted ?? 0),
  };
}

interface MockOpts {
  providers: string[];
  atlas: AtlasEntry[];
  histories?: Record<string, NodeHistory>;
  beacon?: Beacon;
  /** Node ids whose `mesh.request` should reject (to exercise failover). */
  failRequests?: Set<string>;
  /** Reply bytes keyed by node id (default empty). */
  replyFor?: (nodeId: string) => Uint8Array;
}

function mockLocateClient(o: MockOpts): {
  ce: CeClient;
  requested: string[];
  advertised: string[];
} {
  const requested: string[] = [];
  const advertised: string[] = [];
  const ce = {
    discovery: {
      async find(_service: string): Promise<string[]> {
        return o.providers;
      },
      async advertise(service: string): Promise<void> {
        advertised.push(service);
      },
    },
    async atlas(): Promise<AtlasEntry[]> {
      return o.atlas;
    },
    async beacon(): Promise<Beacon> {
      if (!o.beacon) throw new Error("no beacon");
      return o.beacon;
    },
    async history(nodeId: string): Promise<NodeHistory> {
      const h = o.histories?.[nodeId];
      if (!h) throw new Error("no history");
      return h;
    },
    mesh: {
      async request(
        to: string,
        _topic: string,
        _payload: Uint8Array,
        _timeoutMs?: number,
      ): Promise<Uint8Array> {
        requested.push(to);
        if (o.failRequests?.has(to)) throw new Error(`unreachable: ${to}`);
        return o.replyFor ? o.replyFor(to) : new Uint8Array();
      },
    },
  } as unknown as CeClient;
  return { ce, requested, advertised };
}

describe("locate selection", () => {
  it("returns an empty array when no provider advertises the service", async () => {
    const { ce } = mockLocateClient({ providers: [], atlas: [] });
    expect(await locate(ce, "svc")).toEqual([]);
  });

  it("drops providers not present in the atlas (unknown/dead)", async () => {
    const { ce } = mockLocateClient({
      providers: ["alive", "ghost"],
      atlas: [atlasEntry({ nodeId: "alive", lastSeenSecs: 1000 })],
    });
    const out = await locate(ce, "svc", { now: 1000 });
    expect(out.map((i) => i.nodeId)).toEqual(["alive"]);
  });

  it("drops stale advertisements beyond maxStaleSecs", async () => {
    const { ce } = mockLocateClient({
      providers: ["fresh", "stale"],
      atlas: [
        atlasEntry({ nodeId: "fresh", lastSeenSecs: 1000 }),
        atlasEntry({ nodeId: "stale", lastSeenSecs: 800 }),
      ],
    });
    const out = await locate(ce, "svc", { now: 1000, maxStaleSecs: 120 });
    expect(out.map((i) => i.nodeId)).toEqual(["fresh"]);
  });

  it("filters by requireTags", async () => {
    const { ce } = mockLocateClient({
      providers: ["gpu", "cpu"],
      atlas: [
        atlasEntry({ nodeId: "gpu", tags: ["gpu", "region:eu"], lastSeenSecs: 1000 }),
        atlasEntry({ nodeId: "cpu", tags: ["region:eu"], lastSeenSecs: 1000 }),
      ],
    });
    const out = await locate(ce, "svc", { now: 1000, requireTags: ["gpu"] });
    expect(out.map((i) => i.nodeId)).toEqual(["gpu"]);
  });

  it("ranks the higher-trust, higher-capacity instance first", async () => {
    const { ce } = mockLocateClient({
      providers: ["trusted", "stranger"],
      atlas: [
        atlasEntry({ nodeId: "trusted", cpuCores: 16, memMb: 32_768, lastSeenSecs: 1000 }),
        atlasEntry({ nodeId: "stranger", cpuCores: 16, memMb: 32_768, lastSeenSecs: 1000 }),
      ],
      histories: {
        trusted: history({ nodeId: "trusted", jobsPaid: 5000, heartbeatsPaid: 5000 }),
        stranger: history({ nodeId: "stranger", firstHeight: 0 }), // newcomer => trust 0
      },
      now: undefined,
    });
    const out = await locate(ce, "svc", { now: 1000, want: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]!.nodeId).toBe("trusted");
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it("tolerates a missing beacon and missing histories (best-effort)", async () => {
    const { ce } = mockLocateClient({
      providers: ["a"],
      atlas: [atlasEntry({ nodeId: "a", lastSeenSecs: 1000 })],
      // no beacon, no histories
    });
    const out = await locate(ce, "svc", { now: 1000 });
    expect(out.map((i) => i.nodeId)).toEqual(["a"]);
    expect(Number.isFinite(out[0]!.score)).toBe(true);
  });

  it("spreads multiple results across distinct fault domains", async () => {
    const { ce } = mockLocateClient({
      providers: ["eu1", "eu2", "us1"],
      atlas: [
        atlasEntry({ nodeId: "eu1", cpuCores: 16, memMb: 32_768, tags: ["region:eu"], lastSeenSecs: 1000 }),
        atlasEntry({ nodeId: "eu2", cpuCores: 16, memMb: 32_768, tags: ["region:eu"], lastSeenSecs: 1000 }),
        atlasEntry({ nodeId: "us1", cpuCores: 8, memMb: 8_192, tags: ["region:us"], lastSeenSecs: 1000 }),
      ],
    });
    const out = await locate(ce, "svc", { now: 1000, want: 2, spreadDomains: true });
    const domains = out.map((i) => i.faultDomain);
    expect(out).toHaveLength(2);
    expect(domains).toContain("region:eu");
    expect(domains).toContain("region:us");
  });
});

describe("call failover", () => {
  it("returns the first successful reply, failing over past unreachable instances", async () => {
    const { ce, requested } = mockLocateClient({
      providers: ["down", "up"],
      atlas: [
        // `down` ranks higher (more capacity) but its request rejects; `up` succeeds.
        atlasEntry({ nodeId: "down", cpuCores: 16, memMb: 32_768, lastSeenSecs: 1000 }),
        atlasEntry({ nodeId: "up", cpuCores: 4, memMb: 4_096, lastSeenSecs: 1000 }),
      ],
      failRequests: new Set(["down"]),
      replyFor: (id) => new TextEncoder().encode(`hello-${id}`),
    });
    const reply = await call(ce, "svc", "svc/rpc", Uint8Array.of(1), { now: 1000 });
    expect(new TextDecoder().decode(reply)).toBe("hello-up");
    // It tried `down` first, then failed over to `up`.
    expect(requested).toEqual(["down", "up"]);
  });

  it("throws when no instance is found", async () => {
    const { ce } = mockLocateClient({ providers: [], atlas: [] });
    await expect(call(ce, "svc", "svc/rpc", Uint8Array.of(1))).rejects.toThrow(
      /no live instance/,
    );
  });

  it("throws the last error when every instance fails", async () => {
    const { ce } = mockLocateClient({
      providers: ["a", "b"],
      atlas: [
        atlasEntry({ nodeId: "a", lastSeenSecs: 1000 }),
        atlasEntry({ nodeId: "b", lastSeenSecs: 1000 }),
      ],
      failRequests: new Set(["a", "b"]),
    });
    await expect(
      call(ce, "svc", "svc/rpc", Uint8Array.of(1), { now: 1000 }),
    ).rejects.toThrow(/unreachable/);
  });
});

describe("ranking helpers", () => {
  function inst(id: string, score: number, domain: string | null): Instance {
    return {
      nodeId: id,
      score,
      cores: 4,
      memMb: 4096,
      tags: domain ? [domain] : [],
      lastSeenSecs: 0,
      faultDomain: domain,
    };
  }

  it("spread prefers distinct domains", () => {
    const out = spread(
      [inst("a", 0.9, "region:eu"), inst("b", 0.8, "region:eu"), inst("c", 0.7, "region:us")],
      2,
    );
    const domains = out.map((i) => i.faultDomain);
    expect(out).toHaveLength(2);
    expect(domains).toContain("region:eu");
    expect(domains).toContain("region:us");
  });

  it("spread fills from the same domain when there is no alternative", () => {
    const out = spread([inst("a", 0.9, "region:eu"), inst("b", 0.8, "region:eu")], 2);
    expect(out).toHaveLength(2);
  });

  it("spread treats unknown domains as distinct buckets", () => {
    const out = spread([inst("a", 0.9, null), inst("b", 0.8, null)], 2);
    expect(out).toHaveLength(2);
  });

  it("faultDomain precedence: region > zone > asn", () => {
    expect(faultDomain(["zone:z1", "region:eu"])).toBe("region:eu");
    expect(faultDomain(["asn:64500"])).toBe("asn:64500");
    expect(faultDomain(["gpu"])).toBeNull();
  });

  it("beaconJitter is deterministic and bounded", async () => {
    const a = await beaconJitter("node1", "deadbeef");
    const b = await beaconJitter("node1", "deadbeef");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(await beaconJitter("node2", "deadbeef")).not.toBe(a);
  });
});
