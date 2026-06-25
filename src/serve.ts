/**
 * Reusable mesh-app serving — the shared loop for building a **real mesh service** in TS.
 *
 * A mesh app answers requests over the CE mesh (libp2p `request`/`reply` on `/ce/rpc/1`),
 * reached by NodeId with relay/NAT traversal — never over a stored ip:port or a side HTTP
 * channel. {@link serve} is the one correct implementation of that loop for the TS SDK:
 * subscribe to the request topics, drain the node's inbound message stream, dispatch each
 * request to a {@link Handler}, and reply over the mesh — reconnecting with capped
 * exponential backoff and de-duplicating redelivered requests. It ports `ce_rs::serve` so
 * every browser/TS mesh app shares the same loop instead of hand-rolling it.
 *
 * ## Authorization is the app's job
 *
 * The handler receives the **authenticated** sender NodeId (the node verified it) plus the
 * request payload. The app enforces its own policy — typically a `ce-cap` capability chain,
 * since abilities are app-defined opaque strings — before acting. This module is pure mesh
 * transport; authorization is layered on top.
 *
 * @example
 * ```ts
 * import { CeClient, serve } from "@ce-net/sdk";
 *
 * const ce = CeClient.local();
 * const ctrl = new AbortController();
 * // Echo handler: authorize `req.from` here before acting in a real app.
 * await serve(ce, ["my-app/rpc"], (req) => req.payload, { signal: ctrl.signal });
 * ```
 *
 * @packageDocumentation
 */

import type { CeClient } from "./client.js";
import type { AppMessage } from "./types.js";

/** An incoming mesh request delivered to a {@link Handler}. */
export interface ServeRequest {
  /** Authenticated sender NodeId (hex) — the node verified the sender's signature. */
  readonly from: string;
  /** The topic the request arrived on (one of the served topics). */
  readonly topic: string;
  /** The request payload bytes. */
  readonly payload: Uint8Array;
}

/**
 * A mesh request handler: given an authenticated {@link ServeRequest}, produce the reply
 * bytes (sync or async). Decoding and authorization (e.g. `ce-cap`) are the handler's
 * responsibility. A handler should always return a reply (even an encoded error) so the
 * requester's `ce.mesh.request()` never blocks to timeout.
 */
export type Handler = (
  req: ServeRequest,
) => Uint8Array | Promise<Uint8Array>;

/** Options for {@link serve} / {@link serveWhere}. */
export interface ServeOptions {
  /** Abort to shut the loop down cleanly; resolves {@link serve} when fired. */
  signal?: AbortSignal;
  /** Initial reconnect backoff in ms (doubles, capped). Default 250. */
  backoffMs?: number;
  /** Max reconnect backoff in ms. Default 10000. */
  maxBackoffMs?: number;
  /**
   * Optional sink for transport-level diagnostics (reconnects, reply failures, dropped
   * requests). Defaults to a no-op so the SDK never writes to the console for a library
   * consumer. Pass `console.warn` to surface them.
   */
  onWarn?: (message: string, detail?: unknown) => void;
}

/**
 * Serve an explicit set of `topics` until `opts.signal` aborts: subscribe to each, then
 * answer every inbound request from the node's message stream via `handler`, replying over
 * the mesh.
 *
 * Reconnects to the message stream with capped exponential backoff, and de-duplicates by
 * reply token so a request redelivered after a reconnect is answered at most once.
 * Non-request messages (no `replyToken`) and messages on other topics are ignored.
 */
export function serve(
  ce: CeClient,
  topics: readonly string[],
  handler: Handler,
  opts: ServeOptions = {},
): Promise<void> {
  const set = new Set(topics);
  return serveWhere(ce, topics, (t) => set.has(t), handler, opts);
}

/**
 * The general serve loop: answer every inbound request whose topic satisfies `accept`. Use
 * this when topics are a family rather than a fixed set — e.g. a service handling `app/rpc/*`
 * or any `app/` prefix with dynamic sub-topics. `subscribe` lists the pub/sub topics to
 * subscribe to (often empty for purely directed request/reply services, where requests
 * arrive regardless).
 *
 * Reconnects with capped exponential backoff and de-duplicates by reply token. Authorization
 * stays the handler's job.
 */
export async function serveWhere(
  ce: CeClient,
  subscribe: readonly string[],
  accept: (topic: string) => boolean,
  handler: Handler,
  opts: ServeOptions = {},
): Promise<void> {
  const signal = opts.signal;
  const baseBackoff = opts.backoffMs ?? 250;
  const maxBackoff = opts.maxBackoffMs ?? 10_000;
  const warn = opts.onWarn ?? (() => {});

  if (signal?.aborted) return;

  for (const t of subscribe) {
    await ce.mesh.subscribe(t);
  }

  const seen = new Set<number>();
  let backoff = baseBackoff;

  while (!signal?.aborted) {
    // Open a fresh inbound stream; on open failure, back off and retry (unless aborted).
    let iterator: AsyncIterator<AppMessage>;
    try {
      iterator = ce.mesh.streamMessages(signal ? { signal } : {})[
        Symbol.asyncIterator
      ]();
    } catch (err) {
      if (signal?.aborted) return;
      warn("serve: messages stream open failed; backing off", err);
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, maxBackoff);
      continue;
    }
    backoff = baseBackoff;

    // Drain this stream until it ends/errors, then reconnect.
    for (;;) {
      let next: IteratorResult<AppMessage>;
      try {
        next = await iterator.next();
      } catch (err) {
        if (signal?.aborted) return;
        warn("serve: stream error; reconnecting", err);
        break;
      }
      if (signal?.aborted) {
        await closeIterator(iterator);
        return;
      }
      if (next.done) break; // stream ended; reconnect
      await answerOne(ce, handler, accept, seen, next.value, warn);
    }
  }
}

/**
 * Decode one inbound message and, if it is a request on an accepted topic we have not
 * answered yet, run the handler and reply over the mesh.
 */
async function answerOne(
  ce: CeClient,
  handler: Handler,
  accept: (topic: string) => boolean,
  seen: Set<number>,
  m: AppMessage,
  warn: (message: string, detail?: unknown) => void,
): Promise<void> {
  if (!accept(m.topic)) return;
  const token = m.replyToken;
  if (token === null) return; // fire-and-forget message, not a request

  if (seen.has(token)) return; // already answered this request
  seen.add(token);
  // Bound the de-dup set so a long-lived server never grows it without limit.
  if (seen.size > 100_000) {
    seen.clear();
    seen.add(token);
  }

  let payload: Uint8Array;
  try {
    payload = m.payload();
  } catch (err) {
    warn("serve: dropping request with undecodable payload", err);
    return;
  }

  let reply: Uint8Array;
  try {
    reply = await handler({ from: m.from, topic: m.topic, payload });
  } catch (err) {
    warn("serve: handler threw; not replying", err);
    return;
  }

  try {
    await ce.mesh.reply(token, reply);
  } catch (err) {
    warn("serve: reply failed", err);
  }
}

/** Best-effort cleanup of the async iterator when shutting down mid-stream. */
async function closeIterator(it: AsyncIterator<AppMessage>): Promise<void> {
  try {
    await it.return?.(undefined);
  } catch {
    // ignore — we are tearing down anyway
  }
}

/** Sleep `ms`, resolving early (without throwing) if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
