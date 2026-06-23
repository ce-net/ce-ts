# @ce-net/graph

Pure-TypeScript assembly of the CE **Fabric Map** network graph from the *measured* RTT edges
that each CE node publishes at `GET /netgraph`. Implements the stable `ce-graph` query contract
defined in [`ce/docs/compute-fabric.md`](../../ce/docs/compute-fabric.md) §3.4 — the surface that
schedulers, collectives, and the LLM router build on.

Runtime-agnostic (web-standard `fetch` only): runs unchanged on Node 20+, Deno, Bun, browsers,
and edge Workers. Self-contained — no dependency on `@ce-net/sdk`.

## What it reads

- `GET /netgraph` → `[{ peer, rtt_ms, samples, last_seen_secs }]` — per-node directed RTT edges
  (libp2p ping, EWMA-smoothed). The ground-truth edges.
- `GET /atlas` (optional) → `[{ node_id, cpu_cores, mem_mb, running_jobs, last_seen_secs, tags }]`
  — live capacity, folded in when `includeAtlas` is set.

The node only measures its own direct links; everything else here (coordinates, regions,
k-nearest) is pure client-side computation.

## Usage

```ts
import { loadNetworkGraph } from "@ce-net/graph";

const g = await loadNetworkGraph(
  ["http://localhost:8844", "http://other-node:8844"],
  { includeAtlas: true },
);

g.measuredRtt(a, b);   // number | undefined — a direct measured sample, if any
g.predictedRtt(a, b);  // number — Vivaldi/MDS embedding distance (shortest-path fallback)
g.kNearest(node, 3);   // NodeId[] — lowest predicted RTT
g.regions();           // NodeId[][] — latency clusters
g.shortestPath(a, b);  // NodeId[] — min-RTT path for relay/routing
g.bandwidth(a, b);     // undefined until the node ships bw_mbps
g.capacityOf(node);    // NodeCapacity | undefined
g.snapshot();          // FabricSnapshot — topology + coordinates + capacity
```

`fetchNetGraph(nodeUrls)` + `MeasuredGraph.build(observations, capacity)` give you the two steps
separately if you want to cache or merge from other sources.

## How prediction works

Each node reports only its direct links, so any-pair RTT is predicted via a **Vivaldi / MDS
network-coordinate embedding** (Dabek et al., NSDI'04): every measured edge is a spring whose
rest length is the measured RTT, and coordinates relax in R² (configurable) until the embedded
distances match the measurements. `predictedRtt(a, b) = ‖coord_a − coord_b‖`. Direct measurements
are returned verbatim (ground truth); disconnected pairs fall back to the measured shortest path,
then `Infinity`.

`regions()` is connected-components over measured edges at or below `regionThresholdMs` (default
30 ms).

## Develop

```bash
npm run typecheck
npm run test
npm run build
```
