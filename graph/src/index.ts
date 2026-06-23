/**
 * `@ce-net/graph` — pure-TypeScript assembly of the CE Fabric Map.
 *
 * Fetches the *measured* RTT edges that each CE node publishes at `GET /netgraph`
 * (libp2p ping, EWMA-smoothed — see `ce/docs/compute-fabric.md` §3), fuses the per-node
 * vantage points into one undirected weighted graph, computes a Vivaldi/MDS network-coordinate
 * embedding for any-pair RTT prediction, and exposes the stable query contract (§3.4) that
 * schedulers, collectives, and the LLM router are written against.
 *
 * Runtime-agnostic: web-standard `fetch` only, no Node build step required. Mirrors the style
 * of `@ce-net/sdk` (the sibling package) but is fully self-contained.
 *
 * @example
 * ```ts
 * import { loadNetworkGraph } from "@ce-net/graph";
 * const g = await loadNetworkGraph(["http://localhost:8844"], { includeAtlas: true });
 * g.kNearest(myNodeId, 3);
 * g.regions();
 * const snap = g.snapshot();
 * ```
 *
 * @packageDocumentation
 */

import { fetchNetGraph } from "./fetch.js";
import type { FetchOptions } from "./fetch.js";
import { MeasuredGraph } from "./graph.js";
import type { GraphOptions } from "./graph.js";

export { fetchNetGraph } from "./fetch.js";
export type { FetchOptions, FetchResult } from "./fetch.js";

export { MeasuredGraph } from "./graph.js";
export type { GraphOptions } from "./graph.js";

export { embed, coordinateDistance } from "./embedding.js";
export type { EmbeddingOptions } from "./embedding.js";

export type {
  NodeId,
  RawNetGraphEdge,
  RawAtlasEntry,
  MeasuredObservation,
  Edge,
  NodeCapacity,
  Coordinate,
  FabricSnapshot,
} from "./types.js";

/** Options for {@link loadNetworkGraph} — fetch tuning plus graph/embedding tuning. */
export type LoadOptions = FetchOptions & GraphOptions;

/**
 * One-shot convenience: fetch `/netgraph` (and optionally `/atlas`) from the given nodes and
 * assemble a queryable {@link MeasuredGraph}. Per-node fetch failures are tolerated; the graph
 * is built from whatever responded. Re-call to refresh.
 */
export async function loadNetworkGraph(
  nodeUrls: string[],
  options: LoadOptions = {},
): Promise<MeasuredGraph> {
  const result = await fetchNetGraph(nodeUrls, options);
  return MeasuredGraph.build(result.observations, result.capacity, options);
}
