# @ce-net/cap

CE's capability primitive in pure, runtime-agnostic TypeScript — a byte-exact port of the Rust
`ce-cap` crate. A capability minted here verifies on a Rust CE node and vice versa.

It provides:

- Ed25519 keygen/sign/verify (`@noble/ed25519`).
- A **bincode v1** encoder/decoder (fixint LE, u64 length prefixes, u32 enum tags, 1-byte `Option`
  tags, `serialize_bytes` for the domain tag and 64-byte signature, raw fixed `[u8;32]` arrays).
- `capBytes` / `capId` (`sha256`) over the same domain-separated preimage Rust signs.
- `signCapability` / `issue`, `encodeChain` / `decodeChain` (hex tokens), and `verifyChain` — a
  faithful port of Rust `authorize` (attenuation, continuity, temporal, revocation, resource match).

## Install

```sh
npm install @ce-net/cap
```

## Use

```ts
import {
  generateKeypair, issue, encodeChain, verifyChain, defaultCaveats,
} from "@ce-net/cap";

const root = await generateKeypair();
const laptop = await generateKeypair();

const cap = await issue(
  root.secret, root.nodeId, laptop.nodeId,
  ["exec", "sync"], { kind: "any" }, defaultCaveats(), 1n, null,
);

const token = encodeChain([cap]); // hex; portable to the Rust CLI / wallet

const res = await verifyChain({
  selfId: root.nodeId, acceptedRoots: [], selfTags: [],
  now: BigInt(Math.floor(Date.now() / 1000)),
  requester: laptop.nodeId, action: "exec", chain: [cap],
});
// res.ok === true
```

## Cross-language conformance

`test/golden.test.ts` asserts byte-for-byte equality against vectors emitted by the Rust generator.
Regenerate the fixture whenever the wire format changes:

```sh
cd ../../ce
cargo run -p ce-cap --example gen_vectors > ../ce-ts/cap/test/golden-vectors.json
```

The committed fixture ships as an empty placeholder; the golden test runs in placeholder mode until
it is populated. `test/verify.test.ts` gives full behavioral coverage independent of the fixture.

## Numeric types

64-bit fields (`not_before`, `not_after`, `max_credits`, `nonce`) are `bigint`; 32-bit-and-under
fields are `number`. `Option<T>` in Rust maps to `T | null`.
