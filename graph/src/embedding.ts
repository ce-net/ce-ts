/**
 * Client-side network-coordinate embedding.
 *
 * The node only measures its direct links, so any-pair RTT needs prediction. CE's design
 * (`compute-fabric.md` §2.2) calls for a Vivaldi coordinate. Vivaldi is a streaming,
 * spring-relaxation embedding: treat each measured edge as a spring whose rest length is the
 * measured RTT and let the coordinates settle. That is exactly what this module computes —
 * a batch Vivaldi / classical-MDS-by-stress-majorization variant suitable for a client that
 * holds the whole (sparse) edge set at once.
 *
 * Method (documented so callers know what `predictedRtt` means):
 *  - Embed every node into R^d (default d = 2).
 *  - For each measured undirected edge (a, b) with weight w_ab (RTT in ms), apply an iterative
 *    spring update pulling/pushing a and b toward the rest length w_ab, with a decaying step.
 *    This is the standard Vivaldi force model (Dabek et al., NSDI'04) run to convergence over a
 *    fixed batch rather than online.
 *  - `predictedRtt(a, b) = ||coord_a - coord_b||` (Euclidean). For directly measured pairs this
 *    tracks the measurement; for unmeasured pairs it interpolates through the embedding.
 *
 * When two nodes share no path in the measured graph, the embedding cannot relate them, so
 * callers that need a guaranteed value fall back to shortest-path (see `graph.ts`).
 *
 * @packageDocumentation
 */

import type { Coordinate, Edge, NodeId } from "./types.js";

/** Tunables for the embedding. Defaults are chosen to converge on small/medium graphs. */
export interface EmbeddingOptions {
  /** Embedding dimensionality. Default 2 (matches the explorer's force-directed view). */
  dimensions?: number;
  /** Iterations of spring relaxation. Default 300. */
  iterations?: number;
  /** Initial step size (force fraction applied per update). Default 0.25. */
  initialStep?: number;
  /** Minimum step size the decay floors at. Default 0.01. */
  minStep?: number;
  /** Deterministic seed for the initial layout. Default 1. */
  seed?: number;
}

/** A mulberry32 PRNG — tiny, deterministic, dependency-free. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Compute Vivaldi/MDS coordinates for every node touched by `edges`.
 *
 * Returns a map from {@link NodeId} to its coordinate vector. Isolated nodes (no edges) still
 * receive a coordinate (their seeded random position) so the result covers every node passed.
 */
export function embed(
  nodes: NodeId[],
  edges: Edge[],
  options: EmbeddingOptions = {},
): Map<NodeId, Coordinate> {
  const dim = Math.max(1, options.dimensions ?? 2);
  const iterations = Math.max(1, options.iterations ?? 300);
  const initialStep = options.initialStep ?? 0.25;
  const minStep = options.minStep ?? 0.01;
  const rand = rng(options.seed ?? 1);

  const index = new Map<NodeId, number>();
  for (const n of nodes) {
    if (!index.has(n)) index.set(n, index.size);
  }
  const n = index.size;

  // Seed positions on a small random cloud scaled by typical RTT so springs start near range.
  const meanRtt =
    edges.length > 0
      ? edges.reduce((acc, e) => acc + e.rttMs, 0) / edges.length
      : 50;
  const positions: number[][] = [];
  for (let i = 0; i < n; i++) {
    const v: number[] = [];
    for (let k = 0; k < dim; k++) v.push((rand() - 0.5) * meanRtt);
    positions.push(v);
  }

  // Pre-resolve edge endpoint indices once.
  const e2: { i: number; j: number; w: number; conf: number }[] = [];
  for (const e of edges) {
    const i = index.get(e.a);
    const j = index.get(e.b);
    if (i === undefined || j === undefined || i === j) continue;
    // Confidence grows with sample count: more samples => trust the rest length more.
    const conf = e.samples > 0 ? e.samples / (e.samples + 4) : 0.25;
    e2.push({ i, j, w: Math.max(e.rttMs, 0.001), conf });
  }

  for (let it = 0; it < iterations; it++) {
    const step =
      initialStep - (initialStep - minStep) * (it / Math.max(1, iterations - 1));
    for (const { i, j, w, conf } of e2) {
      const pi = positions[i]!;
      const pj = positions[j]!;
      const d = distance(pi, pj);
      // Error between current embedded distance and the measured rest length.
      const err = d - w;
      if (d < 1e-9) {
        // Coincident points: nudge apart along a deterministic axis to break the tie.
        const axis = (i + j) % dim;
        pi[axis] = pi[axis]! - 0.5;
        pj[axis] = pj[axis]! + 0.5;
        continue;
      }
      const force = step * conf * err;
      for (let k = 0; k < dim; k++) {
        const unit = (pi[k]! - pj[k]!) / d;
        pi[k] = pi[k]! - force * unit;
        pj[k] = pj[k]! + force * unit;
      }
    }
  }

  const out = new Map<NodeId, Coordinate>();
  for (const [id, idx] of index) {
    out.set(id, { nodeId: id, vec: positions[idx]!.slice() });
  }
  return out;
}

/** Euclidean distance between two coordinates — the predicted RTT in milliseconds. */
export function coordinateDistance(a: Coordinate, b: Coordinate): number {
  return distance(a.vec, b.vec);
}
