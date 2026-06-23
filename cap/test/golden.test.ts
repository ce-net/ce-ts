/**
 * Cross-language conformance: assert the TS `@ce-net/cap` encoder/signer reproduces, byte-for-byte,
 * the golden vectors emitted by the Rust generator
 * (`cargo run -p ce-cap --example gen_vectors > test/golden-vectors.json`).
 *
 * For each case we rebuild the `Capability` from the JSON fields, then check:
 *   - `capBytes` hex equals the Rust `cap_bytes`,
 *   - `capId` hex equals the Rust `cap_id`,
 *   - re-signing with the same fixed seed reproduces the exact `chain1` hex (Ed25519 over a fixed
 *     key and message is deterministic — RFC 8032 — so this is a strict equality test, not a
 *     verify-only test),
 *   - the decoded chain round-trips and verifies.
 *
 * The two-link `chains` entry additionally pins `encodeChain` for a continuity-correct delegation.
 */

import { describe, expect, it } from "vitest";
import {
  capBytes,
  capId,
  decodeChain,
  encodeChain,
  fromHex,
  issue,
  keypairFromSecret,
  toHex,
  verifyChain,
  verifySig,
  type Capability,
  type Caveats,
  type Resource,
  type SignedCapability,
} from "../src/index.js";
import vectors from "./golden-vectors.json" with { type: "json" };

// ---- JSON -> typed model -------------------------------------------------

interface ResourceJson {
  kind: string;
  node?: string;
  tag?: string;
  tags?: string[];
}

interface CaveatsJson {
  not_before: number | string;
  not_after: number | string;
  max_cpu: number | null;
  max_mem_mb: number | null;
  max_credits: number | string | null;
  allowed_ports: number[] | null;
  path_prefix: string | null;
}

interface CapabilityJson {
  issuer: string;
  audience: string;
  abilities: string[];
  resource: ResourceJson;
  caveats: CaveatsJson;
  nonce: number | string;
  parent: string | null;
}

interface CaseJson {
  name: string;
  cap: CapabilityJson;
  cap_bytes: string;
  cap_id: string;
  chain1: string;
}

interface ChainJson {
  name: string;
  links: CapabilityJson[];
  link0_cap_id: string;
  link1_cap_id: string;
  chain2: string;
}

interface ActorJson {
  seed_fill: number;
  node_id: string;
}

interface Vectors {
  version: string;
  actors: Record<string, ActorJson>;
  cases: CaseJson[];
  chains: ChainJson[];
}

const V = vectors as unknown as Vectors;

// The committed fixture ships as a placeholder (empty cases) until a human runs the Rust generator.
// In placeholder mode the per-case strict-equality assertions have nothing to run; we additionally
// skip the actor-id check (its node_ids are placeholders too). Once real vectors are dropped in,
// every assertion below — including actor ids — becomes a strict cross-language equality test.
const PLACEHOLDER = V.cases.length === 0;

function asBig(v: number | string): bigint {
  return BigInt(v);
}

function resourceFromJson(r: ResourceJson): Resource {
  switch (r.kind) {
    case "any":
      return { kind: "any" };
    case "node":
      return { kind: "node", node: fromHex(r.node!) };
    case "tag":
      return { kind: "tag", tag: r.tag! };
    case "allOf":
      return { kind: "allOf", tags: r.tags! };
    default:
      throw new Error(`unknown resource kind ${r.kind}`);
  }
}

function caveatsFromJson(c: CaveatsJson): Caveats {
  return {
    not_before: asBig(c.not_before),
    not_after: asBig(c.not_after),
    max_cpu: c.max_cpu,
    max_mem_mb: c.max_mem_mb,
    max_credits: c.max_credits === null ? null : asBig(c.max_credits),
    allowed_ports: c.allowed_ports,
    path_prefix: c.path_prefix,
  };
}

function capFromJson(c: CapabilityJson): Capability {
  return {
    issuer: fromHex(c.issuer),
    audience: fromHex(c.audience),
    abilities: c.abilities,
    resource: resourceFromJson(c.resource),
    caveats: caveatsFromJson(c.caveats),
    nonce: asBig(c.nonce),
    parent: c.parent === null ? null : fromHex(c.parent),
  };
}

// Fixed seeds match gen_vectors.rs: single-byte fills.
const SEED = {
  root: new Uint8Array(32).fill(0x11),
  mid: new Uint8Array(32).fill(0x22),
  leaf: new Uint8Array(32).fill(0x33),
  target: new Uint8Array(32).fill(0x44),
} as const;

describe("golden vectors", () => {
  it.skipIf(PLACEHOLDER)("derives the same actor node ids from fixed seeds", async () => {
    for (const [name, seed] of Object.entries(SEED)) {
      const kp = await keypairFromSecret(seed);
      expect(toHex(kp.nodeId)).toBe(V.actors[name]!.node_id);
    }
  });

  for (const c of V.cases) {
    describe(`case: ${c.name}`, () => {
      const cap = capFromJson(c.cap);

      it("cap_bytes matches Rust", () => {
        expect(toHex(capBytes(cap))).toBe(c.cap_bytes);
      });

      it("cap_id matches Rust", () => {
        expect(toHex(capId(cap))).toBe(c.cap_id);
      });

      it("re-signing reproduces the exact chain1 hex (deterministic Ed25519)", async () => {
        // Every case body is issued by `root` (seed 0x11) in the generator.
        const signed = await issue(
          SEED.root,
          cap.issuer,
          cap.audience,
          cap.abilities,
          cap.resource,
          cap.caveats,
          cap.nonce,
          cap.parent,
        );
        expect(encodeChain([signed])).toBe(c.chain1);
      });

      it("chain1 decodes and the link verifies", async () => {
        const chain = decodeChain(c.chain1);
        expect(chain).toHaveLength(1);
        expect(toHex(capBytes(chain[0]!.cap))).toBe(c.cap_bytes);
        expect(await verifySig(chain[0]!)).toBe(true);
      });
    });
  }

  for (const ch of V.chains) {
    describe(`chain: ${ch.name}`, () => {
      it("re-signing reproduces the exact two-link chain2 hex", async () => {
        const c0cap = capFromJson(ch.links[0]!);
        const c1cap = capFromJson(ch.links[1]!);

        const c0 = await issue(
          SEED.root,
          c0cap.issuer,
          c0cap.audience,
          c0cap.abilities,
          c0cap.resource,
          c0cap.caveats,
          c0cap.nonce,
          c0cap.parent,
        );
        expect(toHex(capId(c0.cap))).toBe(ch.link0_cap_id);

        const c1 = await issue(
          SEED.mid,
          c1cap.issuer,
          c1cap.audience,
          c1cap.abilities,
          c1cap.resource,
          c1cap.caveats,
          c1cap.nonce,
          c1cap.parent,
        );
        expect(toHex(capId(c1.cap))).toBe(ch.link1_cap_id);

        const chain: SignedCapability[] = [c0, c1];
        expect(encodeChain(chain)).toBe(ch.chain2);
      });

      it("chain2 decodes, round-trips, and authorizes the leaf", async () => {
        const chain = decodeChain(ch.chain2);
        expect(chain).toHaveLength(2);
        // Re-encoding the decoded chain must yield the identical token.
        expect(encodeChain(chain)).toBe(ch.chain2);

        const root = chain[0]!.cap.issuer;
        const leaf = chain[chain.length - 1]!.cap.audience;
        const result = await verifyChain({
          selfId: root,
          acceptedRoots: [],
          selfTags: [],
          now: 1000n,
          requester: leaf,
          action: "exec",
          chain,
        });
        expect(result.ok).toBe(true);
      });
    });
  }
});
