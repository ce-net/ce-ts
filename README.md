# @ce-net/sdk

Runtime-agnostic TypeScript client for the [CE](https://ce-net.com) node HTTP + SSE API.
Mirrors the Rust SDK (`ce-rs`) 1:1, and additionally wraps the SSE streams and CEP-1
signals that `ce-rs` skips. Web-standard APIs only (`fetch`, `ReadableStream`,
`AbortController`, `TextDecoder`, `crypto`) — the same bundle runs on **Node 20+, Deno,
Bun, browsers, and Cloudflare/Vercel edge Workers**.

```bash
npm install @ce-net/sdk
```

## Quickstart

```ts
import { CeClient, Amount } from "@ce-net/sdk";

const ce = CeClient.local(); // 127.0.0.1:8844, auto-discovers api.token (Node/Bun/Deno)

// status + money
const s = await ce.getStatus();
console.log(`node ${s.nodeId} @ height ${s.height}, balance ${s.balance.toCredits()}`);

// transfer 1.5 credits — an Amount, never a JS number
await ce.transfer(recipientHex, Amount.fromCredits("1.5"));

// live block feed over SSE (browser, Node, Workers — identical)
const ctrl = new AbortController();
for await (const blk of ce.streams.blocks({ signal: ctrl.signal })) {
  console.log(blk.index, blk.hash, blk.txCount);
}

// mesh request/reply — the canonical device-to-device app channel
const reply = await ce.mesh.request(peerHex, "notes/sync", payload, 10_000);
```

## The money model (read this)

CE denominates money in **integer base units**: `1 credit = 10^18 base units`, wei-style,
**never floating point**. On the wire, every amount is a **decimal string** of base units
(values exceed JavaScript's `2^53` safe-integer limit, so a JS `number` would silently lose
precision).

The SDK makes `number` structurally impossible for money via the `bigint`-backed `Amount`
value type:

```ts
import { Amount, CREDIT } from "@ce-net/sdk";

Amount.fromCredits("1.5");        // human decimal → base units (exact string math)
Amount.fromWholeCredits(100);     // 100 * 10^18
Amount.fromBaseUnits("1500000000000000000"); // wire form

const a = Amount.fromCredits("1.5");
a.toBaseUnits();  // "1500000000000000000"  (wire / request bodies)
a.toCredits();    // "1.5"                  (human display, trims trailing zeros)
a.toString();     // "1.5 credits"
a.toJSON();       // "1500000000000000000"  — safe in JSON.stringify, never a bare bigint
a.add(b); a.sub(b); a.cmp(b); a.isZero(); a.isNegative();

CREDIT; // 1_000_000_000_000_000_000n
```

Raw wire response types keep amount fields as `string`; decoders lift them into `Amount`,
so a naive `JSON.parse` never coerces money to a `number`. `Amount` is in exact parity with
`ce-rs`'s `Amount(i128)` (same parse/format rules, same wire form). The one documented
difference from `ce-rs` is the data-layer `cid()`, which is **async** here (Web SubtleCrypto).

## Construction & auth

```ts
new CeClient({
  baseUrl: "http://127.0.0.1:8844",   // default
  token: "…" | (() => string | Promise<string | undefined>),
  fetch: customFetch,                  // injectable (Workers / tests / proxy)
  timeoutMs: 30_000,
  maxRetries: 2,                       // money writes self-override to 0
  headers: { "x-app": "notes" },
});

CeClient.local();                      // 127.0.0.1:8844, lazy token discovery
CeClient.withToken(baseUrl, token);    // explicit
```

Token discovery order (runtime-aware): explicit `token` → `CE_API_TOKEN` env (Node/Bun/Deno)
→ `<data_dir>/api.token` (Node/Bun/Deno only, via a guarded dynamic `import('node:fs')` that
edge bundlers tree-shake out). **Auth is attached on non-GET requests only**, matching the
node's gating; read-only GETs go unauthenticated. The token is never logged.

> Browser note: browsers cannot read `<data_dir>/api.token` by design. For mutating calls
> from a browser, supply a `token` callback (e.g. fetched from the ce-hub sidecar / a local
> proxy), or route through a same-origin authenticated proxy. Read-only GETs work directly
> (CORS permitting).

## Errors

All failures throw a `CeError` subclass; use `instanceof` to narrow. HTTP `{ "error": "…" }`
bodies are parsed into `.body`.

```
CeError
 ├─ CeApiError (.status, .body, .requestId?)
 │   ├─ CeBadRequestError        400
 │   ├─ CeAuthError              401 / 403
 │   ├─ CeInsufficientFundsError 402   ← bid / transfer / channel open
 │   ├─ CeNotFoundError          404
 │   ├─ CeRateLimitError         429   (.retryAfter)
 │   ├─ CePeerError              502   ← mesh RPC peer rejected
 │   ├─ CeUnavailableError       503   ← Docker unavailable
 │   ├─ CeTimeoutError           504   ← mesh RPC timeout
 │   └─ CeServerError            other 5xx
 ├─ CeConnectionError   network / DNS / abort / client timeout
 └─ CeStreamError       SSE decode / disconnect
```

Retries fire only on `408/425/429/5xx` and network errors with full-jitter exponential
backoff (honoring `Retry-After`); **never** on `400/401/402/403/404`. State-creating money
endpoints (`/transfer`, `/jobs/bid`, `/channels/open`) attach an auto `Idempotency-Key` and
default to **0 retries** to avoid double-submit until the node honors idempotency keys.

## SSE streams

Four typed `AsyncIterable`s, each with auto-reconnect + `Last-Event-ID` resume. No
`EventSource` (it can't set auth headers and is absent in Node/Workers).

```ts
for await (const b of ce.streams.blocks(opts))       { /* BlockEvent */ }
for await (const t of ce.streams.transactions(opts)) { /* TxEvent (amount: Amount) */ }
for await (const s of ce.streams.signals(opts))      { /* Signal */ }
for await (const m of ce.streams.messages(opts))     { /* AppMessage */ }
// opts: { signal?: AbortSignal; reconnect?: boolean; lastEventId?: string }
```

## Surface (every endpoint)

| Namespace | Methods |
|---|---|
| `ce.status` | `health` `status` `bootstrap` `beacon` `atlas` |
| `ce.jobs` | `list` `get` `bid` `settle` `kill` `meshDeploy` `meshDeployWasm` `meshKill` |
| `ce.economy` | `transfer` `history` `payRelay` |
| `ce.channels` | `list` `open` `signReceipt` `close` `expire` |
| `ce.data` | `putBlob` `getBlob` `putObject` `getObject` `fetchChunkPaid` (+ `cid` `chunkObject` `reassemble`) |
| `ce.mesh` | `send` `messages` `subscribe` `publish` `request` `reply` `streamMessages` |
| `ce.signals` | `list` `send` `stream` |
| `ce.names` / `ce.discovery` | `claim` `resolve` / `advertise` `find` |
| `ce.capabilities` | `revoke` `revoked` |
| `ce.streams` | `blocks` `transactions` `signals` `messages` |
| `ce.wallet` / `ce.tags` | `balance` `history` `send` `watch` / `advertise` `find` |
| flat / control | `ce.tunnel` `ce.chainSave` + flat aliases (`ce.getStatus()`, `ce.transfer()`, `ce.bid()`, …) |

The `serve` / `serveWhere` (mesh-app request/reply handlers), `locate` / `call` / `register`
(service discovery), and `connectNode` / `bridgeFetch` (in-browser node bridge) helpers are
also exported from the package root — see `src/serve.ts`, `src/locate.ts`, `src/browser-node.ts`.

The SDK holds **no key material** and performs **no signing** — `settle` and channel `close`
forward a caller-built `payerSig` hex string; the node signs receipts on `signReceipt`.
It opens **no sockets to peers** and stores **no ip:port**: mesh is reached only through the
node's HTTP mesh endpoints (mesh-first is preserved by the node's libp2p routing).

## Runtime matrix

| Runtime | Status | Notes |
|---|---|---|
| Node 20+ | ✅ | full token discovery (env + `api.token` file) |
| Bun | ✅ | full token discovery |
| Deno | ✅ | env token discovery (file via `node:fs` shim) |
| Browser | ✅ | read-only GET + SSE work directly; mutating calls need a `token` callback; CORS applies |
| Cloudflare / Vercel Workers | ✅ | inject `fetch`/`token`; `node:fs` is never statically linked |

## OpenAPI

A hand-authored [`openapi.yaml`](./openapi.yaml) (3.1) ships alongside this package as the
secondary artifact for Python/Go/Java codegen (e.g. Speakeasy). All amount fields are typed
`string` / `format: decimal` (never `number`/`integer`); SSE endpoints are documented as
`text/event-stream` and need a hand-written streaming shim per language. The TS and Rust SDKs
remain hand-written flagships — codegen produces awkward output for the `Amount`/`bigint` type
and the SSE `AsyncIterable`s.

## License

AGPL-3.0-only © Leif Rydenfalk. A commercial license is also available — see
[`LICENSING.md`](./LICENSING.md) and [`COMMERCIAL-LICENSE.md`](./COMMERCIAL-LICENSE.md).
