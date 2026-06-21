/**
 * fetch + ReadableStream SSE → AsyncIterable.
 *
 * Deliberately does NOT use `EventSource` (can't set auth headers; absent in Node/Workers).
 * Instead: `fetch(url, { headers: { Accept: 'text/event-stream', 'Last-Event-ID'? } })`,
 * pipe through `TextDecoderStream`, buffer by `\n\n`, parse `data:`/`event:`/`id:`/comment.
 * Works identically across Node 20+, Deno, Bun, browsers, and Workers.
 *
 * On disconnect (and `reconnect !== false`), backoff-reconnects sending `Last-Event-ID`
 * for resume. Cancel via `signal`.
 */

import { CeStreamError } from "./errors.js";

/** Shared options for every SSE stream. */
export interface StreamOptions {
  /** Abort the stream (and any reconnect loop). */
  signal?: AbortSignal;
  /** Reconnect on disconnect. Default `true`. */
  reconnect?: boolean;
  /** Resume from this event id (sent as `Last-Event-ID`). */
  lastEventId?: string;
  /** Base reconnect backoff in ms. Default 1000. */
  reconnectBaseMs?: number;
  /** Max reconnect backoff in ms. Default 15000. */
  reconnectMaxMs?: number;
}

/** A single parsed SSE event. */
export interface SseEvent {
  /** The `event:` field, or `"message"` by default. */
  event: string;
  /** The accumulated `data:` payload (lines joined by `\n`). */
  data: string;
  /** The `id:` field, if any. */
  id?: string;
}

/** Dependencies the iterable needs (so it shares the client's fetch + auth posture). */
export interface SseSource {
  /** Absolute URL of the stream endpoint. */
  url: string;
  /** Injected fetch. */
  fetch: typeof fetch;
  /** Resolve the auth token (may be undefined for unauthenticated GET streams). */
  authToken: () => Promise<string | undefined>;
  /** Extra default headers. */
  headers?: Record<string, string>;
}

/**
 * Open an SSE endpoint and yield raw {@link SseEvent}s as an AsyncIterable, with
 * reconnect + Last-Event-ID resume. Higher-level stream methods map+validate the
 * `data` JSON into typed domain objects.
 */
export async function* sseEvents(
  source: SseSource,
  opts: StreamOptions = {},
): AsyncGenerator<SseEvent, void, unknown> {
  const reconnect = opts.reconnect ?? true;
  const baseMs = opts.reconnectBaseMs ?? 1000;
  const maxMs = opts.reconnectMaxMs ?? 15000;
  let lastId = opts.lastEventId;
  let attempt = 0;

  while (!opts.signal?.aborted) {
    let connectedThisRound = false;
    try {
      const headers: Record<string, string> = {
        ...source.headers,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      };
      if (lastId !== undefined) headers["Last-Event-ID"] = lastId;
      // SSE endpoints are GET and unauthenticated on the node, but attach a token if we
      // have one (harmless, and future-proofs authed streams).
      const token = await source.authToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await source.fetch(source.url, {
        method: "GET",
        headers,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      if (!res.ok) {
        throw new CeStreamError(`SSE endpoint returned HTTP ${res.status}`);
      }
      if (!res.body) {
        throw new CeStreamError("SSE response had no body");
      }

      connectedThisRound = true;
      attempt = 0; // reset backoff after a successful connect

      for await (const ev of parseSseStream(res.body)) {
        if (ev.id !== undefined) lastId = ev.id;
        // Skip pure keep-alive comments (no event/data).
        if (ev.data === "" && ev.event === "message") continue;
        yield ev;
      }
      // Stream ended cleanly (server closed). Fall through to reconnect logic.
    } catch (err) {
      if (opts.signal?.aborted) return;
      if (!reconnect) {
        if (err instanceof CeStreamError) throw err;
        throw new CeStreamError(
          `SSE stream failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      // else: fall through to backoff + retry
    }

    if (opts.signal?.aborted) return;
    if (!reconnect) return;

    // Backoff before reconnecting. If we never connected, escalate; if we connected
    // and the stream simply ended, reconnect promptly.
    const delay = connectedThisRound
      ? baseMs
      : Math.min(maxMs, baseMs * 2 ** attempt) * (0.5 + Math.random() * 0.5);
    if (!connectedThisRound) attempt++;
    await sleep(delay, opts.signal);
  }
}

/**
 * Parse a `text/event-stream` ReadableStream into SSE events. Correctly handles events
 * split across read boundaries (the #1 SSE bug), multi-line `data:`, and comments.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  let dataLines: string[] = [];
  let eventType = "message";
  // Per spec, the last-event-id buffer persists across events; an `id:` line updates it.
  let lastEventId: string | undefined;
  let sawData = false;

  const flush = (): SseEvent | undefined => {
    // The HTML SSE algorithm only dispatches when the data buffer is non-empty.
    // A lone `id:`/`event:` with no `data:` updates state but emits nothing.
    if (!sawData) {
      dataLines = [];
      eventType = "message";
      return undefined;
    }
    const ev: SseEvent = {
      event: eventType,
      data: dataLines.join("\n"),
    };
    if (lastEventId !== undefined) ev.id = lastEventId;
    dataLines = [];
    eventType = "message";
    sawData = false;
    return ev;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      // Process complete lines. SSE line terminators: \n, \r, or \r\n.
      while ((nl = indexOfLineEnd(buffer)) !== -1) {
        const lineEnd = nl;
        let next = lineEnd + 1;
        // Collapse \r\n.
        if (buffer[lineEnd] === "\r" && buffer[next] === "\n") next = lineEnd + 2;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(next);

        if (line === "") {
          // Blank line => dispatch the buffered event.
          const ev = flush();
          if (ev) yield ev;
          continue;
        }
        if (line.startsWith(":")) {
          // Comment / keep-alive — ignore.
          continue;
        }
        const colon = line.indexOf(":");
        let field: string;
        let val: string;
        if (colon === -1) {
          field = line;
          val = "";
        } else {
          field = line.slice(0, colon);
          val = line.slice(colon + 1);
          if (val.startsWith(" ")) val = val.slice(1);
        }
        switch (field) {
          case "data":
            dataLines.push(val);
            sawData = true;
            break;
          case "event":
            eventType = val;
            break;
          case "id":
            // A NUL in the id is ignored per spec; otherwise it updates last-event-id.
            if (!val.includes("\0")) lastEventId = val;
            break;
          case "retry":
            // Reconnect time hint — not used here.
            break;
          default:
            break;
        }
      }
    }
    // Stream done — emit any trailing buffered event if a final blank line was missing.
    const ev = flush();
    if (ev) yield ev;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function indexOfLineEnd(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\n" || ch === "\r") return i;
  }
  return -1;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
