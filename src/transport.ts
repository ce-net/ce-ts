/**
 * The single fetch wrapper: auth, retry, idempotency, timeouts, error mapping.
 *
 * - Uses an injected `fetch` or the global one. Web-standard only.
 * - Auth: attaches `Authorization: Bearer <token>` on all **non-GET** requests
 *   (matching the node's gating). GETs go unauthenticated. The token is never logged.
 * - Idempotency: state-creating POSTs (`/transfer`, `/jobs/bid`, `/channels/open`) get
 *   an auto `Idempotency-Key` unless the caller overrides; harmless if the node ignores it.
 * - Retry: only on 408/429/5xx and network errors; never on 400/401/402/403/404. Full-jitter
 *   exponential backoff, honoring `Retry-After`, capped at `maxRetries`.
 */

import { resolveToken, type TokenSource } from "./auth.js";
import {
  CeConnectionError,
  errorFromStatus,
  type CeApiError,
} from "./errors.js";

/** Options accepted by the {@link Transport} constructor. */
export interface TransportOptions {
  baseUrl: string;
  token?: TokenSource;
  fetch?: typeof fetch;
  timeoutMs: number;
  maxRetries: number;
  headers?: Record<string, string>;
}

/** Per-request options. */
export interface RequestOptions {
  /** Already-serialized JSON object, raw bytes, or `undefined`. */
  body?: unknown;
  /** When `true` send raw bytes (`application/octet-stream`) instead of JSON. */
  rawBody?: Uint8Array;
  /** Force auth on/off. Defaults: GET → false, others → true. */
  auth?: boolean;
  /** Mark this request idempotent (adds an Idempotency-Key if none supplied). */
  idempotent?: boolean;
  /** Override the default timeout for this call. */
  timeoutMs?: number;
  /** Caller-supplied abort signal, merged with the timeout. */
  signal?: AbortSignal;
  /** Extra per-request headers. */
  headers?: Record<string, string>;
  /** Disable retries for this call (e.g. money writes when the node ignores idempotency). */
  maxRetries?: number;
}

/** How the caller wants the successful body decoded. */
export type Decode = "json" | "text" | "bytes" | "void";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class Transport {
  private readonly baseUrl: string;
  private readonly tokenSource: TokenSource | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: TransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.tokenSource = opts.token;
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new CeConnectionError(
        "no global fetch available; pass `fetch` in CeClientOptions",
      );
    }
    // Bind to globalThis to preserve `this` for some runtimes.
    this.fetchImpl = opts.fetch ?? f.bind(globalThis);
    this.timeoutMs = opts.timeoutMs;
    this.maxRetries = opts.maxRetries;
    this.defaultHeaders = opts.headers ?? {};
  }

  /** The resolved base URL (used by the SSE layer). */
  url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /** The fetch implementation in use (shared with the SSE layer). */
  fetch(): typeof fetch {
    return this.fetchImpl;
  }

  /** Resolve the current auth token (string | sync | async source). */
  async authToken(): Promise<string | undefined> {
    return resolveToken(this.tokenSource);
  }

  /** Default headers (used by the SSE layer to share auth posture). */
  baseHeaders(): Record<string, string> {
    return { ...this.defaultHeaders };
  }

  /** Perform a typed request, returning the decoded body. */
  async request<T>(
    method: string,
    path: string,
    decode: Decode,
    opts: RequestOptions = {},
  ): Promise<T> {
    const isGet = method === "GET";
    const needAuth = opts.auth ?? !isGet;
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    const url = this.url(path);

    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      ...this.defaultHeaders,
      ...opts.headers,
    };

    let bodyInit: BodyInit | undefined;
    if (opts.rawBody !== undefined) {
      bodyInit = toArrayBufferView(opts.rawBody);
      headers["Content-Type"] ??= "application/octet-stream";
    } else if (opts.body !== undefined) {
      bodyInit = JSON.stringify(opts.body);
      headers["Content-Type"] ??= "application/json";
    }

    if (needAuth) {
      const token = await this.authToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }

    if (opts.idempotent && headers["Idempotency-Key"] === undefined) {
      headers["Idempotency-Key"] = randomUuid();
    }

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      const { controller, cleanup } = makeAbort(
        opts.timeoutMs ?? this.timeoutMs,
        opts.signal,
      );
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers,
          ...(bodyInit !== undefined ? { body: bodyInit } : {}),
          signal: controller.signal,
        });
        cleanup();

        if (res.ok) {
          return await decodeBody<T>(res, decode);
        }

        const apiErr = await buildApiError(res);
        if (attempt < maxRetries && RETRYABLE_STATUS.has(res.status)) {
          await sleep(backoffMs(attempt, retryAfterMs(res)));
          attempt++;
          continue;
        }
        throw apiErr;
      } catch (err) {
        cleanup();
        if (isCeApiError(err)) throw err;
        // Network / abort / timeout.
        const connErr = toConnectionError(err, opts.signal);
        if (attempt < maxRetries && !isCallerAbort(opts.signal)) {
          await sleep(backoffMs(attempt));
          attempt++;
          continue;
        }
        throw connErr;
      }
    }
  }
}

// ---- helpers ----

function isCeApiError(e: unknown): e is CeApiError {
  return (
    typeof e === "object" &&
    e !== null &&
    "status" in e &&
    "body" in e &&
    e instanceof Error
  );
}

async function buildApiError(res: Response): Promise<CeApiError> {
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    bodyText = "";
  }
  let message = res.statusText || `HTTP ${res.status}`;
  let parsed = bodyText;
  if (bodyText) {
    try {
      const j = JSON.parse(bodyText) as { error?: unknown };
      if (typeof j.error === "string") {
        message = j.error;
        parsed = j.error;
      }
    } catch {
      // Non-JSON body — keep raw text.
    }
  }
  const requestId =
    res.headers.get("x-request-id") ?? res.headers.get("x-ce-request-id") ?? undefined;
  const retryAfter = retryAfterSeconds(res);
  return errorFromStatus(res.status, message, parsed, {
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  });
}

async function decodeBody<T>(res: Response, decode: Decode): Promise<T> {
  switch (decode) {
    case "void":
      // Drain to free the connection.
      try {
        await res.arrayBuffer();
      } catch {
        // ignore
      }
      return undefined as T;
    case "text":
      return (await res.text()) as T;
    case "bytes":
      return new Uint8Array(await res.arrayBuffer()) as T;
    case "json": {
      const txt = await res.text();
      if (txt.trim() === "") return undefined as T;
      return JSON.parse(txt) as T;
    }
  }
}

function toConnectionError(err: unknown, signal?: AbortSignal): CeConnectionError {
  if (err instanceof CeConnectionError) return err;
  if (isAbortError(err)) {
    if (isCallerAbort(signal)) {
      return new CeConnectionError("request aborted by caller", { cause: err });
    }
    return new CeConnectionError("request timed out", { cause: err });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new CeConnectionError(`network request failed: ${msg}`, { cause: err });
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: string }).name === "AbortError"
  );
}

function isCallerAbort(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Merge a timeout with a caller signal into a single AbortController. */
function makeAbort(
  timeoutMs: number,
  caller?: AbortSignal,
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  const onAbort = () => controller.abort();
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener("abort", onAbort, { once: true });
  }
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (caller) caller.removeEventListener("abort", onAbort);
  };
  return { controller, cleanup };
}

function retryAfterMs(res: Response): number | undefined {
  const s = retryAfterSeconds(res);
  return s === undefined ? undefined : s * 1000;
}

function retryAfterSeconds(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return n;
  const date = Date.parse(h);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return undefined;
}

/** Full-jitter exponential backoff, base 200ms, capped at 10s. */
function backoffMs(attempt: number, floor?: number): number {
  const exp = Math.min(10_000, 200 * 2 ** attempt);
  const jittered = Math.random() * exp;
  return Math.max(floor ?? 0, jittered);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback (very old runtimes): pseudo-random, not cryptographic.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Normalize a Uint8Array into a body that every runtime's fetch accepts. */
function toArrayBufferView(bytes: Uint8Array): BodyInit {
  // A fresh copy backed by a plain ArrayBuffer (avoids SharedArrayBuffer typing issues).
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
