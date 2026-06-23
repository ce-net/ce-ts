import { describe, expect, it } from "vitest";

import { fetchNetGraph, loadNetworkGraph, MeasuredGraph } from "../src/index.js";
import type {
  MeasuredObservation,
  RawAtlasEntry,
  RawNetGraphEdge,
} from "../src/index.js";

/** Build a directed observation tersely. */
function obs(
  origin: string,
  peer: string,
  rttMs: number,
  samples = 10,
  lastSeenSecs = 100,
): MeasuredObservation {
  return { origin, peer, rttMs, samples, lastSeenSecs };
}

describe("MeasuredGraph.build — edge fusion", () => {
  it("fuses bidirectional observations into one sample-weighted undirected edge", () => {
    // A measured B at 40ms (10 samples); B measured A at 60ms (30 samples).
    // Weighted mean = (40*10 + 60*30) / 40 = (400 + 1800) / 40 = 55.
    const g = MeasuredGraph.build([
      obs("A", "B", 40, 10),
      obs("B", "A", 60, 30),
    ]);
    expect(g.measuredRtt("A", "B")).toBeCloseTo(55, 6);
    // Order-independent.
    expect(g.measuredRtt("B", "A")).toBeCloseTo(55, 6);
    expect(g.nodes().sort()).toEqual(["A", "B"]);
  });

  it("drops self-edges and treats identical nodes as zero RTT", () => {
    const g = MeasuredGraph.build([obs("A", "A", 5), obs("A", "B", 10)]);
    expect(g.measuredRtt("A", "A")).toBe(0);
    expect(g.nodes().sort()).toEqual(["A", "B"]);
  });

  it("returns undefined for an unmeasured direct pair", () => {
    const g = MeasuredGraph.build([obs("A", "B", 10), obs("B", "C", 10)]);
    expect(g.measuredRtt("A", "C")).toBeUndefined();
  });
});

describe("predictedRtt", () => {
  it("returns the measured value verbatim for a direct edge", () => {
    const g = MeasuredGraph.build([obs("A", "B", 42)]);
    expect(g.predictedRtt("A", "B")).toBeCloseTo(42, 6);
  });

  it("predicts a finite RTT for an unmeasured but connected pair", () => {
    // Chain A-B-C, both legs 20ms. A and C are unmeasured but reachable.
    const g = MeasuredGraph.build(
      [obs("A", "B", 20), obs("B", "C", 20)],
      [],
      { embedding: { iterations: 500 } },
    );
    const p = g.predictedRtt("A", "C");
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
    // The triangle through B costs 40ms; the embedding should not exceed that path cost grossly.
    expect(p).toBeLessThanOrEqual(40 + 1e-6);
  });

  it("returns Infinity for fully disconnected nodes", () => {
    const g = MeasuredGraph.build([obs("A", "B", 10), obs("C", "D", 10)]);
    expect(g.predictedRtt("A", "C")).toBe(Infinity);
  });
});

describe("kNearest", () => {
  it("orders neighbours by predicted RTT ascending", () => {
    const g = MeasuredGraph.build([
      obs("hub", "near", 5),
      obs("hub", "mid", 25),
      obs("hub", "far", 90),
    ]);
    expect(g.kNearest("hub", 2)).toEqual(["near", "mid"]);
    expect(g.kNearest("hub", 10)).toEqual(["near", "mid", "far"]);
  });

  it("excludes the node itself and unreachable nodes", () => {
    const g = MeasuredGraph.build([obs("A", "B", 5), obs("C", "D", 5)]);
    // From A, only B is reachable; C/D are in another component.
    expect(g.kNearest("A", 5)).toEqual(["B"]);
  });

  it("returns empty for unknown node or non-positive k", () => {
    const g = MeasuredGraph.build([obs("A", "B", 5)]);
    expect(g.kNearest("Z", 3)).toEqual([]);
    expect(g.kNearest("A", 0)).toEqual([]);
  });
});

describe("regions — latency clustering", () => {
  it("groups low-latency nodes and isolates a high-latency link", () => {
    // Two tight clusters (5ms internal) joined by a slow 200ms WAN link.
    const g = MeasuredGraph.build(
      [
        obs("a1", "a2", 5),
        obs("a2", "a3", 4),
        obs("b1", "b2", 6),
        obs("a3", "b1", 200), // cross-region: above threshold, must not merge
      ],
      [],
      { regionThresholdMs: 30 },
    );
    const regions = g.regions();
    expect(regions.length).toBe(2);
    const sizes = regions.map((r) => r.length).sort();
    expect(sizes).toEqual([2, 3]);
    const big = regions.find((r) => r.length === 3)!;
    expect(big.sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("places a node with no qualifying edge in its own singleton region", () => {
    const g = MeasuredGraph.build([obs("a", "b", 5), obs("a", "c", 500)], [], {
      regionThresholdMs: 30,
    });
    const regions = g.regions();
    // {a,b} together, {c} alone.
    expect(regions.length).toBe(2);
    expect(regions.some((r) => r.length === 1 && r[0] === "c")).toBe(true);
  });
});

describe("shortestPath", () => {
  it("finds the minimum-RTT path, not the fewest-hops path", () => {
    // Direct A-C is 100ms; A-B-C is 20+20=40ms — the cheaper route wins.
    const g = MeasuredGraph.build([
      obs("A", "C", 100),
      obs("A", "B", 20),
      obs("B", "C", 20),
    ]);
    expect(g.shortestPath("A", "C")).toEqual(["A", "B", "C"]);
  });

  it("returns [] for unreachable endpoints and [node] for self", () => {
    const g = MeasuredGraph.build([obs("A", "B", 5), obs("C", "D", 5)]);
    expect(g.shortestPath("A", "C")).toEqual([]);
    expect(g.shortestPath("A", "A")).toEqual(["A"]);
  });
});

describe("bandwidth", () => {
  it("returns undefined (node does not measure bandwidth yet)", () => {
    const g = MeasuredGraph.build([obs("A", "B", 5)]);
    expect(g.bandwidth("A", "B")).toBeUndefined();
  });
});

describe("capacity + snapshot", () => {
  it("folds capacity and exposes it via capacityOf and snapshot", () => {
    const g = MeasuredGraph.build(
      [obs("A", "B", 5)],
      [
        {
          nodeId: "A",
          cpuCores: 8,
          memMb: 16384,
          runningJobs: 2,
          lastSeenSecs: 50,
          tags: ["gpu", "linux"],
        },
      ],
    );
    expect(g.capacityOf("A")?.cpuCores).toBe(8);
    expect(g.capacityOf("B")).toBeUndefined();

    const snap = g.snapshot();
    expect(snap.nodes.sort()).toEqual(["A", "B"]);
    expect(snap.edges.length).toBe(1);
    expect(snap.coordinates.length).toBe(2);
    expect(snap.capacity.length).toBe(1);
    expect(typeof snap.assembledAtMs).toBe("number");
  });

  it("snapshot is a deep copy — mutating it does not affect the graph", () => {
    const g = MeasuredGraph.build([obs("A", "B", 5)]);
    const snap = g.snapshot();
    snap.edges[0]!.rttMs = 999;
    snap.nodes.push("X");
    expect(g.measuredRtt("A", "B")).toBeCloseTo(5, 6);
    expect(g.nodes()).not.toContain("X");
  });
});

describe("fetchNetGraph — runtime-agnostic fetch over injected impl", () => {
  function mockFetch(
    byPath: Record<string, RawNetGraphEdge[] | RawAtlasEntry[] | { fail: true }>,
  ): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      for (const [suffix, body] of Object.entries(byPath)) {
        if (url.endsWith(suffix)) {
          if ((body as { fail?: true }).fail) {
            return new Response("nope", { status: 503 });
          }
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("maps snake_case wire shape to observations and tags origin with the node url", async () => {
    const edges: RawNetGraphEdge[] = [
      { peer: "B", rtt_ms: 12.5, samples: 7, last_seen_secs: 99 },
    ];
    const result = await fetchNetGraph(["http://node-a"], {
      fetch: mockFetch({ "/netgraph": edges }),
    });
    expect(result.failures).toEqual([]);
    expect(result.observations).toEqual([
      {
        origin: "http://node-a",
        peer: "B",
        rttMs: 12.5,
        samples: 7,
        lastSeenSecs: 99,
      },
    ]);
  });

  it("records per-node failures without throwing", async () => {
    const result = await fetchNetGraph(["http://down"], {
      fetch: mockFetch({ "/netgraph": { fail: true } }),
    });
    expect(result.observations).toEqual([]);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.url).toBe("http://down");
  });

  it("folds atlas capacity when includeAtlas is set", async () => {
    const edges: RawNetGraphEdge[] = [
      { peer: "B", rtt_ms: 10, samples: 5, last_seen_secs: 10 },
    ];
    const atlas: RawAtlasEntry[] = [
      {
        node_id: "A",
        cpu_cores: 4,
        mem_mb: 8192,
        running_jobs: 1,
        last_seen_secs: 10,
        tags: ["docker"],
      },
    ];
    const result = await fetchNetGraph(["http://node-a"], {
      includeAtlas: true,
      fetch: mockFetch({ "/netgraph": edges, "/atlas": atlas }),
    });
    expect(result.capacity.length).toBe(1);
    expect(result.capacity[0]!.cpuCores).toBe(4);
    expect(result.capacity[0]!.tags).toEqual(["docker"]);
  });

  it("loadNetworkGraph assembles a queryable graph end-to-end", async () => {
    const edges: RawNetGraphEdge[] = [
      { peer: "B", rtt_ms: 15, samples: 5, last_seen_secs: 10 },
    ];
    const g = await loadNetworkGraph(["http://node-a"], {
      fetch: mockFetch({ "/netgraph": edges }),
    });
    expect(g.has("http://node-a")).toBe(true);
    expect(g.has("B")).toBe(true);
    expect(g.measuredRtt("http://node-a", "B")).toBeCloseTo(15, 6);
  });
});
