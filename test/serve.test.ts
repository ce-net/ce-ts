import { describe, it, expect } from "vitest";
import { serve, serveWhere } from "../src/serve.js";
import type { CeClient } from "../src/client.js";
import type { AppMessage } from "../src/types.js";

/** Build an AppMessage from parts, with a real `payload()` decoder. */
function msg(parts: {
  from?: string;
  topic: string;
  payload: Uint8Array;
  replyToken: number | null;
}): AppMessage {
  return {
    from: parts.from ?? "peer-a",
    topic: parts.topic,
    payloadHex: "",
    receivedAt: null,
    replyToken: parts.replyToken,
    payload: () => parts.payload,
  };
}

/**
 * A mock CeClient exposing only the mesh surface `serve` touches. `messages` is the queue of
 * inbound app messages; the stream yields them then ends (so the serve loop would reconnect —
 * we abort after draining to stop it).
 */
function mockServeClient(messages: AppMessage[]): {
  ce: CeClient;
  subscribed: string[];
  replies: Array<{ token: number; payload: Uint8Array }>;
  streamOpens: number;
} {
  const subscribed: string[] = [];
  const replies: Array<{ token: number; payload: Uint8Array }> = [];
  let streamOpens = 0;

  const mesh = {
    async subscribe(topic: string): Promise<void> {
      subscribed.push(topic);
    },
    async reply(token: number, payload: Uint8Array): Promise<void> {
      replies.push({ token, payload });
    },
    // eslint-disable-next-line require-yield
    async *streamMessages(): AsyncIterable<AppMessage> {
      streamOpens++;
      for (const m of messages) {
        yield m;
      }
      // Stream ends after draining; the serve loop reconnects unless aborted.
    },
  };

  const ce = { mesh } as unknown as CeClient;
  return {
    ce,
    subscribed,
    replies,
    get streamOpens() {
      return streamOpens;
    },
  };
}

describe("serve dispatch + reply", () => {
  it("subscribes, dispatches each request to the handler, and replies with its bytes", async () => {
    const m1 = msg({ topic: "app/rpc", payload: Uint8Array.of(1, 2, 3), replyToken: 10 });
    const m2 = msg({ topic: "app/rpc", payload: Uint8Array.of(9), replyToken: 11 });
    const { ce, subscribed, replies } = mockServeClient([m1, m2]);

    const seen: number[] = [];
    const ctrl = new AbortController();
    // Echo handler that records and aborts after the second request so the loop exits.
    const done = serve(
      ce,
      ["app/rpc"],
      (req) => {
        seen.push(req.payload.length);
        if (seen.length === 2) ctrl.abort();
        return Uint8Array.from([...req.payload].reverse());
      },
      { signal: ctrl.signal },
    );
    await done;

    expect(subscribed).toEqual(["app/rpc"]);
    expect(replies).toHaveLength(2);
    expect(replies[0]).toEqual({ token: 10, payload: Uint8Array.of(3, 2, 1) });
    expect(replies[1]).toEqual({ token: 11, payload: Uint8Array.of(9) });
  });

  it("ignores non-request messages (no replyToken) and other topics", async () => {
    const fireAndForget = msg({ topic: "app/rpc", payload: Uint8Array.of(1), replyToken: null });
    const otherTopic = msg({ topic: "other", payload: Uint8Array.of(2), replyToken: 5 });
    const realReq = msg({ topic: "app/rpc", payload: Uint8Array.of(3), replyToken: 6 });
    const { ce, replies } = mockServeClient([fireAndForget, otherTopic, realReq]);

    const ctrl = new AbortController();
    let handled = 0;
    const done = serve(
      ce,
      ["app/rpc"],
      (req) => {
        handled++;
        ctrl.abort();
        return req.payload;
      },
      { signal: ctrl.signal },
    );
    await done;

    expect(handled).toBe(1);
    expect(replies).toEqual([{ token: 6, payload: Uint8Array.of(3) }]);
  });

  it("de-duplicates a redelivered request by reply token (answers at most once)", async () => {
    const a = msg({ topic: "app/rpc", payload: Uint8Array.of(1), replyToken: 42 });
    const dup = msg({ topic: "app/rpc", payload: Uint8Array.of(1), replyToken: 42 });
    const b = msg({ topic: "app/rpc", payload: Uint8Array.of(2), replyToken: 43 });
    const { ce, replies } = mockServeClient([a, dup, b]);

    const ctrl = new AbortController();
    let calls = 0;
    const done = serve(
      ce,
      ["app/rpc"],
      (req) => {
        calls++;
        // Abort once the unique second token (43) is handled.
        if (req.payload[0] === 2) ctrl.abort();
        return req.payload;
      },
      { signal: ctrl.signal },
    );
    await done;

    // The duplicate token-42 message was suppressed: the handler ran twice (tokens 42, 43),
    // and exactly two replies were sent.
    expect(calls).toBe(2);
    expect(replies.map((r) => r.token)).toEqual([42, 43]);
  });

  it("supports serveWhere with a topic predicate (family of topics)", async () => {
    const a = msg({ topic: "app/rpc/get", payload: Uint8Array.of(1), replyToken: 1 });
    const b = msg({ topic: "app/rpc/put", payload: Uint8Array.of(2), replyToken: 2 });
    const c = msg({ topic: "unrelated/x", payload: Uint8Array.of(3), replyToken: 3 });
    const { ce, replies } = mockServeClient([a, b, c]);

    const ctrl = new AbortController();
    let handled = 0;
    const done = serveWhere(
      ce,
      [],
      (t) => t.startsWith("app/rpc/"),
      (req) => {
        handled++;
        if (handled === 2) ctrl.abort();
        return req.payload;
      },
      { signal: ctrl.signal },
    );
    await done;

    expect(handled).toBe(2);
    expect(replies.map((r) => r.token)).toEqual([1, 2]);
  });

  it("does nothing when the signal is already aborted", async () => {
    const { ce, subscribed, replies } = mockServeClient([
      msg({ topic: "app/rpc", payload: Uint8Array.of(1), replyToken: 1 }),
    ]);
    const ctrl = new AbortController();
    ctrl.abort();
    await serve(ce, ["app/rpc"], (req) => req.payload, { signal: ctrl.signal });
    expect(subscribed).toEqual([]);
    expect(replies).toEqual([]);
  });
});
