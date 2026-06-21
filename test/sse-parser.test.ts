import { describe, it, expect } from "vitest";
import { parseSseStream, type SseEvent } from "../src/sse.js";

/** Build a ReadableStream that emits the given string chunks as UTF-8 bytes. */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i]!));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

async function collect(chunks: string[]): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of parseSseStream(streamFromChunks(chunks))) {
    out.push(ev);
  }
  return out;
}

describe("SSE parser", () => {
  it("parses a simple data event", async () => {
    const events = await collect(['data: {"index":1}\n\n']);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe('{"index":1}');
    expect(events[0]!.event).toBe("message");
  });

  it("handles events split across read boundaries (the #1 SSE bug)", async () => {
    const events = await collect(["data: hel", "lo\n", "\ndata: wor", "ld\n\n"]);
    expect(events.map((e) => e.data)).toEqual(["hello", "world"]);
  });

  it("supports multi-line data, event type, and id", async () => {
    const events = await collect(["event: tx\nid: 42\ndata: a\ndata: b\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("tx");
    expect(events[0]!.id).toBe("42");
    expect(events[0]!.data).toBe("a\nb");
  });

  it("ignores keep-alive comments", async () => {
    const events = await collect([": keep-alive\n\n", "data: x\n\n"]);
    expect(events.map((e) => e.data)).toEqual(["x"]);
  });

  it("handles CRLF line endings", async () => {
    const events = await collect(["data: x\r\n\r\n"]);
    expect(events.map((e) => e.data)).toEqual(["x"]);
  });

  it("emits a trailing event without a final blank line", async () => {
    const events = await collect(["data: last\n"]);
    expect(events.map((e) => e.data)).toEqual(["last"]);
  });
});
