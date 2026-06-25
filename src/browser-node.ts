/**
 * Browser-node bridge — the single, shared contract that lets stranger code talk ONLY to
 * the local node.
 *
 * Two transports, both SAME-ORIGIN (which is what makes one strict CSP work):
 *
 *  1. In-browser WASM node: the producer page (e.g. `web/site/node.html`) boots a CE node in
 *     this tab and installs `window.__ceNode`, a {@link CeNodeBridge}. Its `request(...)`
 *     dispatches IN-PROCESS to that node — it NEVER touches the network. The sentinel base URL
 *     {@link BRIDGE_BASE_URL} (`http://ce-browser-node.local`) marks a fetch as "route to the
 *     bridge". {@link bridgeFetch} wraps the bridge in a `fetch`-shaped function so the SDK's
 *     normal request + SSE paths consume it unmodified.
 *
 *  2. Native local/relay node: reached via a same-origin reverse proxy at `/ce` (the ce-app
 *     serve layer proxies `/ce/*` to `127.0.0.1:8844`). Plain global `fetch`, same origin.
 *
 * {@link connectNode} picks transport (1) if `window.__ceNode` exists, else (2), and returns a
 * ready {@link CeClient}. Both honor {@link CE_STRICT_CSP}: `connect-src 'self'` means the page
 * can reach ONLY its own origin — no `ce-net.com/db`, no `cast.ce-net.com`, no arbitrary fetch.
 *
 * NODE-SIDE REQUIREMENT (what a producer page MUST provide): an object on
 * `window.__ceNode` implementing {@link CeNodeBridge.request}. Given a node HTTP API
 * `method` + `path` (+ optional headers/body), it executes the request against the
 * in-process node and resolves `{ status, headers, body }` where `body` is:
 *   - a `string` (JSON or text responses),
 *   - a `Uint8Array`/`ArrayBuffer` (binary, e.g. `GET /blobs/:hash`), or
 *   - a `ReadableStream<Uint8Array>` of SSE frames for stream paths
 *     (e.g. `GET /mesh/messages/stream`), each frame `data: <json>\n\n`.
 * Anything the in-browser node can't serve yet should resolve `{ status: 501, ... }` rather
 * than throw, so callers see a clean error instead of a hang.
 */

import { CeClient } from "./client.js";
import type { TokenSource } from "./auth.js";

/** The exact Content-Security-Policy that confines an app page to its own origin (the node). */
export const CE_STRICT_CSP =
  "default-src 'self'; connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
  "base-uri 'self'; object-src 'none'; frame-ancestors 'none'";

/** Sentinel base URL the adapter recognises as "route to the in-browser node bridge". */
export const BRIDGE_BASE_URL = "http://ce-browser-node.local";

/** Same-origin reverse-proxy prefix for a native local/relay node (ce-app serve layer). */
export const SAME_ORIGIN_NODE_PATH = "/ce";

/** Per-request options handed to {@link CeNodeBridge.request}. */
export interface BridgeRequestInit {
  /** Request headers (lower- or mixed-case keys both accepted). */
  headers?: Record<string, string>;
  /**
   * Request body. A `string` is sent as-is (JSON/text); a `Uint8Array`/`ArrayBuffer` is sent
   * as raw bytes (e.g. `PUT /blobs/:hash`). Absent for GETs.
   */
  body?: string | Uint8Array | ArrayBuffer;
  /** Aborts the in-process request (and any stream it opened). */
  signal?: AbortSignal;
}

/**
 * The response shape the bridge resolves. `body` mirrors what the node returned:
 *   - `string` for JSON/text,
 *   - `Uint8Array`/`ArrayBuffer` for binary,
 *   - `ReadableStream<Uint8Array>` of `data: ...\n\n` frames for SSE (paths ending in `/stream`).
 * `null`/`undefined` body means "no content".
 */
export interface BridgeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | null;
}

/**
 * The method surface the in-browser node exposes on `window.__ceNode`. This is the
 * acceptance contract between every app/SDK workstream and the browser-node producer page.
 * ONE method: every node HTTP route maps to a `(method, path)` pair.
 */
export interface CeNodeBridge {
  /** Node identifier, when the in-browser node has finished generating its identity. */
  readonly nodeId?: string;
  /** A marker some producers set so feature-detection can be done without a network probe. */
  readonly ready?: boolean;
  /**
   * Dispatch a node HTTP request IN-PROCESS. `path` is a node API path (`/status`,
   * `/mesh/publish`, `/mesh/messages/stream`, `/blobs/:hash`, ...). Never throws for a
   * route the node simply doesn't implement — resolve `{ status: 501 }` instead.
   */
  request(
    method: string,
    path: string,
    init?: BridgeRequestInit,
  ): Promise<BridgeResponse>;
}

/** Read the injected bridge, if any. */
export function getBridge(): CeNodeBridge | null {
  const w = globalThis as { __ceNode?: CeNodeBridge };
  const b = w.__ceNode;
  return b && typeof b.request === "function" ? b : null;
}

/** True when an in-browser node bridge is present on `window`. */
export function bridgeAvailable(): boolean {
  return getBridge() !== null;
}

/**
 * A `fetch`-compatible function that routes calls aimed at {@link BRIDGE_BASE_URL} into the
 * `window.__ceNode` bridge. SSE GETs (paths ending `/stream`) come back as a streaming
 * `Response` so the SDK's SSE parser consumes them normally; binary bodies (`/blobs`) round-trip
 * as bytes. Any non-bridge URL throws — a client built with this fetch must only ever point at
 * the sentinel base URL.
 */
export function bridgeFetch(bridge: CeNodeBridge): typeof fetch {
  const impl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    if (u.origin !== new URL(BRIDGE_BASE_URL).origin) {
      throw new TypeError(
        `bridgeFetch only serves ${BRIDGE_BASE_URL}; refusing to fetch ${u.origin}`,
      );
    }
    const path = u.pathname + u.search;
    const method = (init?.method ?? "GET").toUpperCase();
    const signal = (init?.signal ?? undefined) as AbortSignal | undefined;
    const headers = headersToRecord(init?.headers);

    const reqInit: BridgeRequestInit = { headers };
    if (signal) reqInit.signal = signal;
    const body = normalizeBody(init?.body);
    if (body !== undefined) reqInit.body = body;

    let res: BridgeResponse;
    try {
      res = await bridge.request(method, path, reqInit);
    } catch (err) {
      // A throwing bridge would otherwise surface as a confusing network error; normalize it
      // to a 502 so the SDK maps it to a clean CeServerError.
      return textResponse(502, `in-browser node error: ${errMessage(err)}`);
    }

    return toResponse(res);
  };
  return impl as typeof fetch;
}

/** Options for {@link connectNode}. */
export interface ConnectNodeOptions {
  /** API token (or resolver) for write calls — only used for the same-origin `/ce` transport. */
  token?: TokenSource;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Extra default headers on every request. */
  headers?: Record<string, string>;
  /**
   * Override the same-origin node path (default `/ce`). Only used when no `window.__ceNode`
   * bridge is present.
   */
  sameOriginPath?: string;
}

/**
 * Build a {@link CeClient} for whichever node transport is available — per the SHARED CONTRACT:
 *
 *  - `window.__ceNode` present → in-process bridge at {@link BRIDGE_BASE_URL}.
 *  - otherwise → same-origin reverse proxy (default `/ce`).
 *
 * Both are SAME-ORIGIN, so a single strict CSP (`connect-src 'self'`) confines the page to the
 * node and nothing else.
 */
export function connectNode(opts: ConnectNodeOptions = {}): CeClient {
  const bridge = getBridge();
  if (bridge) {
    return new CeClient({
      baseUrl: BRIDGE_BASE_URL,
      fetch: bridgeFetch(bridge),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
    });
  }
  // Same-origin proxy. `new URL(path, origin)` keeps it on this page's origin so CSP holds.
  const base = sameOriginBase(opts.sameOriginPath ?? SAME_ORIGIN_NODE_PATH);
  return new CeClient({
    baseUrl: base,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
  });
}

// ---- internals ----

/** Resolve the same-origin node base URL (e.g. `https://app.example/ce`). */
function sameOriginBase(path: string): string {
  const clean = `/${path.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  const origin =
    (globalThis as { location?: { origin?: string } }).location?.origin ?? "";
  return `${origin}${clean}`;
}

/** Turn a {@link BridgeResponse} into a standard `Response` the SDK transport understands. */
function toResponse(res: BridgeResponse): Response {
  const status = res.status;
  const headers = new Headers();
  if (res.headers) {
    for (const [k, v] of Object.entries(res.headers)) headers.set(k, v);
  }
  const body = res.body;

  // SSE / any streaming body: hand the ReadableStream straight through.
  if (isReadableStream(body)) {
    if (!headers.has("Content-Type")) headers.set("Content-Type", "text/event-stream");
    return new Response(body, { status, headers });
  }
  if (body instanceof Uint8Array) {
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/octet-stream");
    }
    return new Response(toArrayBuffer(body), { status, headers });
  }
  if (body instanceof ArrayBuffer) {
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/octet-stream");
    }
    return new Response(body, { status, headers });
  }
  if (typeof body === "string") {
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", looksJson(body) ? "application/json" : "text/plain");
    }
    return new Response(body, { status, headers });
  }
  // No body (void responses).
  return new Response(null, { status, headers });
}

function textResponse(status: number, text: string): Response {
  return new Response(JSON.stringify({ error: text }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
  } else {
    Object.assign(out, h);
  }
  return out;
}

/** Normalize a fetch BodyInit into the bridge's `string | Uint8Array | ArrayBuffer | undefined`. */
function normalizeBody(
  body: BodyInit | null | undefined,
): string | Uint8Array | ArrayBuffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body.length > 0 ? body : undefined;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  // URLSearchParams / Blob / streams are not used by the SDK transport; coerce to string.
  return String(body);
}

function isReadableStream(v: unknown): v is ReadableStream<Uint8Array> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { getReader?: unknown }).getReader === "function"
  );
}

function looksJson(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[") || t.startsWith('"');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
