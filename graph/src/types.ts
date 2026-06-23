/**
 * Wire and domain types for the CE network graph.
 *
 * The node exposes `GET /netgraph` (see `ce/docs/compute-fabric.md` §3 and
 * `ce/crates/ce-node/src/lib.rs::RttStat`): an array of the *measured* RTT edges from the
 * queried node to each of its directly connected libp2p peers. Each entry is a flattened
 * `{ peer, rtt_ms, samples, last_seen_secs }`. `GET /atlas` carries the live capacity
 * snapshot (`{ node_id, cpu_cores, mem_mb, running_jobs, last_seen_secs, tags }`).
 *
 * These are the only two surfaces this SDK reads. Everything else (Vivaldi coordinates,
 * regions, k-nearest) is pure client-side computation over the measured edges.
 *
 * @packageDocumentation
 */

/**
 * A single raw `/netgraph` entry exactly as the node serializes it (snake_case wire form).
 * `peer` is the hex libp2p PeerId of the connected peer; the *origin* of the edge is the node
 * that served the response (the URL passed to {@link fetchNetGraph}).
 */
export interface RawNetGraphEdge {
  /** Hex libp2p PeerId of the directly connected peer. */
  peer: string;
  /** Smoothed (EWMA) round-trip time to that peer, in milliseconds. */
  rtt_ms: number;
  /** Number of ping samples folded into the estimate. */
  samples: number;
  /** Unix seconds of the most recent sample. */
  last_seen_secs: number;
}

/** A single raw `/atlas` entry as the node serializes it (snake_case wire form). */
export interface RawAtlasEntry {
  node_id: string;
  cpu_cores: number;
  mem_mb: number;
  running_jobs: number;
  last_seen_secs: number;
  tags?: string[];
}

/** Stable node identifier used throughout the graph (a libp2p PeerId or node URL key). */
export type NodeId = string;

/**
 * A directed, measured observation: `origin` measured `rttMs` to `peer`. The graph folds the
 * two directions of the same pair into one undirected weighted edge (see {@link Edge}).
 */
export interface MeasuredObservation {
  /** The node that produced the measurement (the netgraph URL key / its self id). */
  origin: NodeId;
  /** The peer the measurement is to. */
  peer: NodeId;
  rttMs: number;
  samples: number;
  lastSeenSecs: number;
}

/**
 * An undirected, weighted edge in the assembled graph. `rttMs` is the fused estimate from
 * however many directed observations were seen for the `{a, b}` pair (sample-weighted mean).
 */
export interface Edge {
  a: NodeId;
  b: NodeId;
  /** Fused round-trip time estimate in milliseconds. */
  rttMs: number;
  /** Total samples behind the fused estimate (sum over directions). */
  samples: number;
  /** Most recent `last_seen_secs` across the observations. */
  lastSeenSecs: number;
}

/** Live capacity for a node, normalized to camelCase. Optional — present only if an atlas was folded in. */
export interface NodeCapacity {
  nodeId: NodeId;
  cpuCores: number;
  memMb: number;
  runningJobs: number;
  lastSeenSecs: number;
  tags: string[];
}

/** A 2-D Vivaldi-style network coordinate produced by the MDS embedding. */
export interface Coordinate {
  nodeId: NodeId;
  /** Embedding position. Dimensionality is fixed at construction (default 2). */
  vec: number[];
}

/**
 * A serializable snapshot of the assembled graph — the `snapshot()` of the query contract.
 * This is the `FabricMap`-shaped view this SDK is responsible for (topology + coordinates;
 * full `NodeProfile`s are added by a later layer once `ce-bench` publishes them).
 */
export interface FabricSnapshot {
  nodes: NodeId[];
  edges: Edge[];
  coordinates: Coordinate[];
  capacity: NodeCapacity[];
  /** Unix milliseconds the snapshot was assembled. */
  assembledAtMs: number;
}
