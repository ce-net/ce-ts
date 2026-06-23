/**
 * Standalone behavioral tests for the verification algorithm (no Rust fixture needed). These mirror
 * the key cases in the Rust `ce-cap` unit tests, confirming the TS port of `authorize` enforces the
 * same attenuation, continuity, temporal, revocation, and resource rules.
 */

import { describe, expect, it } from "vitest";
import {
  capId,
  defaultCaveats,
  generateKeypair,
  issue,
  verifyChain,
  type Caveats,
  type Keypair,
  type Resource,
  type SignedCapability,
} from "../src/index.js";

const ANY: Resource = { kind: "any" };

function expires(at: bigint): Caveats {
  return { ...defaultCaveats(), not_after: at };
}

async function actors(): Promise<{ root: Keypair; mid: Keypair; leaf: Keypair; other: Keypair }> {
  return {
    root: await generateKeypair(),
    mid: await generateKeypair(),
    leaf: await generateKeypair(),
    other: await generateKeypair(),
  };
}

async function selfIssued(
  issuer: Keypair,
  audience: Keypair,
  abilities: string[],
  resource: Resource = ANY,
  caveats: Caveats = defaultCaveats(),
  nonce = 1n,
): Promise<SignedCapability> {
  return issue(issuer.secret, issuer.nodeId, audience.nodeId, abilities, resource, caveats, nonce, null);
}

describe("verifyChain", () => {
  it("authorizes a granted ability on a self-issued cap", async () => {
    const { root, leaf } = await actors();
    const c = await selfIssued(root, leaf, ["exec", "sync"]);
    const ok = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 1000n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [c],
    });
    expect(ok.ok).toBe(true);
  });

  it("denies an ability the cap does not grant", async () => {
    const { root, leaf } = await actors();
    const c = await selfIssued(root, leaf, ["exec"]);
    const r = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 1000n,
      requester: leaf.nodeId,
      action: "tunnel",
      chain: [c],
    });
    expect(r.ok).toBe(false);
  });

  it("denies an empty chain", async () => {
    const { root, leaf } = await actors();
    const r = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 1000n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [],
    });
    expect(r.ok).toBe(false);
  });

  it("denies an unaccepted root", async () => {
    const { root, mid, leaf } = await actors();
    // issued by `mid`, but the node only trusts `root`
    const c = await selfIssued(mid, leaf, ["exec"]);
    const r = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 1000n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [c],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("accepted authority");
  });

  it("accepts a configured org root", async () => {
    const { root, mid, leaf } = await actors();
    const c = await selfIssued(mid, leaf, ["exec"]);
    const r = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [mid.nodeId],
      selfTags: [],
      now: 1000n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [c],
    });
    expect(r.ok).toBe(true);
  });

  it("denies the wrong audience presenting a cap", async () => {
    const { root, leaf, other } = await actors();
    const c = await selfIssued(root, leaf, ["exec"]);
    const r = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 1000n,
      requester: other.nodeId,
      action: "exec",
      chain: [c],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not held by");
  });

  it("enforces expiry", async () => {
    const { root, leaf } = await actors();
    const c = await selfIssued(root, leaf, ["exec"], ANY, expires(500n));
    const expired = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 1000n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [c],
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.reason).toContain("expired");

    const valid = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 499n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [c],
    });
    expect(valid.ok).toBe(true);
  });

  it("enforces revocation by (issuer, nonce)", async () => {
    const { root, leaf } = await actors();
    const c = await selfIssued(root, leaf, ["exec"], ANY, defaultCaveats(), 42n);
    const r = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 1000n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [c],
      isRevoked: (_issuer, nonce) => nonce === 42n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("revoked");
  });

  it("matches a Resource::Tag against node tags", async () => {
    const { root, leaf } = await actors();
    const c = await selfIssued(root, leaf, ["exec"], { kind: "tag", tag: "gpu" });
    const onGpu = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: ["gpu", "linux"],
      now: 1000n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [c],
    });
    expect(onGpu.ok).toBe(true);

    const offGpu = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: ["linux"],
      now: 1000n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [c],
    });
    expect(offGpu.ok).toBe(false);
  });

  it("authorizes a valid two-link chain and rejects ability amplification", async () => {
    const { root, mid, leaf } = await actors();
    const c0 = await issue(root.secret, root.nodeId, mid.nodeId, ["exec", "sync"], ANY, defaultCaveats(), 1n, null);
    const c1 = await issue(mid.secret, mid.nodeId, leaf.nodeId, ["exec"], ANY, defaultCaveats(), 2n, capId(c0.cap));
    const ok = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 1000n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [c0, c1],
    });
    expect(ok.ok).toBe(true);

    // mid grants tunnel it never held
    const bad = await issue(mid.secret, mid.nodeId, leaf.nodeId, ["exec", "tunnel"], ANY, defaultCaveats(), 3n, capId(c0.cap));
    const r = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 1000n,
      requester: leaf.nodeId,
      action: "tunnel",
      chain: [c0, bad],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("exceed the parent");
  });

  it("rejects broken continuity (wrong issuer)", async () => {
    const { root, mid, other, leaf } = await actors();
    const c0 = await issue(root.secret, root.nodeId, mid.nodeId, ["exec"], ANY, defaultCaveats(), 1n, null);
    // c1 issued by `other`, not by parent's audience `mid`
    const c1 = await issue(other.secret, other.nodeId, leaf.nodeId, ["exec"], ANY, defaultCaveats(), 2n, capId(c0.cap));
    const r = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 1000n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [c0, c1],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("parent's audience");
  });

  it("rejects a wrong parent hash", async () => {
    const { root, mid, leaf } = await actors();
    const c0 = await issue(root.secret, root.nodeId, mid.nodeId, ["exec"], ANY, defaultCaveats(), 1n, null);
    const bogus = new Uint8Array(32).fill(9);
    const c1 = await issue(mid.secret, mid.nodeId, leaf.nodeId, ["exec"], ANY, defaultCaveats(), 2n, bogus);
    const r = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 1000n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [c0, c1],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("parent hash");
  });

  it("rejects a root link that names a parent", async () => {
    const { root, leaf } = await actors();
    const bogus = new Uint8Array(32).fill(1);
    const c0 = await issue(root.secret, root.nodeId, leaf.nodeId, ["exec"], ANY, defaultCaveats(), 1n, bogus);
    const r = await verifyChain({
      selfId: root.nodeId,
      acceptedRoots: [],
      selfTags: [],
      now: 1000n,
      requester: leaf.nodeId,
      action: "exec",
      chain: [c0],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("must not name a parent");
  });
});
