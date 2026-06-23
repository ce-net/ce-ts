/**
 * Type definitions mirroring the Rust `ce-cap` crate one-for-one. A `NodeId` is a 32-byte Ed25519
 * public key; a `CapId` is the 32-byte sha256 content-address of a capability's signed preimage.
 * Both are carried as raw `Uint8Array` in memory and hex strings on the wire/CLI.
 */

/** 32-byte Ed25519 public key — a node's identity. */
export type NodeId = Uint8Array;

/** 32-byte sha256(cap_bytes) — names a capability for linking and revocation. */
export type CapId = Uint8Array;

/**
 * Which nodes a capability applies to. Mirrors the Rust `Resource` enum; the `kind` tag maps to the
 * enum's bincode u32 variant index (any=0, node=1, tag=2, allOf=3).
 */
export type Resource =
  | { kind: "any" }
  | { kind: "node"; node: NodeId }
  | { kind: "tag"; tag: string }
  | { kind: "allOf"; tags: string[] };

/**
 * Constraints attached to a capability. Field order and `null`/`Some` semantics mirror the Rust
 * `Caveats` struct exactly. A `null` Option encodes as a single `0x00` byte; `Some(v)` as `0x01`
 * followed by `v`. All numeric fields are non-negative integers (`number` for 32-bit-and-under,
 * `bigint` for the 64-bit `not_before`/`not_after`/`max_credits`).
 */
export interface Caveats {
  /** Unix seconds before which the capability is not yet valid. 0n = no lower bound. */
  not_before: bigint;
  /** Unix seconds after which the capability is invalid. 0n = never expires. */
  not_after: bigint;
  /** Max CPU cores (u32) — null = no limit. */
  max_cpu: number | null;
  /** Max memory MB (u32) — null = no limit. */
  max_mem_mb: number | null;
  /** Max credits (u64) — null = no limit. */
  max_credits: bigint | null;
  /** Allowed remote ports (u16 each) — null = unrestricted. */
  allowed_ports: number[] | null;
  /** Path-prefix confinement — null = unrestricted. */
  path_prefix: string | null;
}

/** A fresh, all-default `Caveats` (matches Rust `Caveats::default()` — all zero/None). */
export function defaultCaveats(): Caveats {
  return {
    not_before: 0n,
    not_after: 0n,
    max_cpu: null,
    max_mem_mb: null,
    max_credits: null,
    allowed_ports: null,
    path_prefix: null,
  };
}

/** The unsigned capability statement. Field order mirrors the Rust `Capability` struct. */
export interface Capability {
  /** Who is delegating (the signer). */
  issuer: NodeId;
  /** Who receives this authority (the holder). */
  audience: NodeId;
  /** The operations granted (opaque action strings). */
  abilities: string[];
  /** Which nodes this applies to. */
  resource: Resource;
  /** Constraints. */
  caveats: Caveats;
  /** Issuer-chosen identifier, unique per issuer (u64). */
  nonce: bigint;
  /** CapId of the parent in the delegation chain — null for a root delegation. */
  parent: CapId | null;
}

/** A `Capability` plus the issuer's 64-byte Ed25519 signature over its `cap_bytes`. */
export interface SignedCapability {
  cap: Capability;
  sig: Uint8Array;
}
