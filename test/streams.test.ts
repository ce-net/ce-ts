import { describe, it, expect } from "vitest";
import { StreamsApi } from "../src/api/streams.js";
import { Transport } from "../src/transport.js";
import { Amount } from "../src/amount.js";
import { CeStreamError } from "../src/errors.js";

/**
 * Build a Response whose body is a `text/event-stream` of the given chunks,
 * optionally split across read boundaries to exercise the SSE line-buffering.
 */
function sseResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(status === 200 ? body : null, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function streamsApi(responses: Response[]): { api: StreamsApi; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return r;
  }) as unknown as typeof fetch;
  const t = new Transport({
    baseUrl: "http://node:8844",
    fetch: fetchImpl,
    maxRetries: 0,
  });
  return { api: new StreamsApi(t), calls };
}

describe("StreamsApi SSE decoding", () => {
  it("decodes block events from a single-shot stream", async () => {
    const ev = JSON.stringify({
      index: 42,
      hash: "deadbeef",
      prev_hash: "cafe",
      timestamp: 1700000000,
      miner: "node-a",
      tx_count: 3,
      nonce: 9,
    });
    const { api, calls } = streamsApi([sseResponse([`data: ${ev}\n\n`])]);
    const out = [];
    for await (const b of api.blocks({ reconnect: false })) out.push(b);
    expect(out).toHaveLength(1);
    expect(out[0]!.index).toBe(42);
    expect(out[0]!.miner).toBe("node-a");
    expect(out[0]!.txCount).toBe(3);
    expect(out[0]!.prevHash).toBe("cafe");
    expect(calls[0]).toBe("http://node:8844/blocks/stream");
  });

  it("decodes transaction events split across read boundaries", async () => {
    const ev = JSON.stringify({
      id: "tx-1",
      origin: "node-a",
      kind: "Transfer",
      amount: "2500000000000000000",
    });
    const frame = `data: ${ev}\n\n`;
    // Split mid-frame to exercise the SSE buffer across chunk boundaries.
    const mid = Math.floor(frame.length / 2);
    const { api } = streamsApi([sseResponse([frame.slice(0, mid), frame.slice(mid)])]);
    const out = [];
    for await (const tx of api.transactions({ reconnect: false })) out.push(tx);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("tx-1");
    expect(out[0]!.kind).toBe("Transfer");
    expect(out[0]!.amount).toBeInstanceOf(Amount);
    expect(out[0]!.amount.toCredits()).toBe("2.5");
  });

  it("UptimeReward with no amount field decodes to Amount.ZERO", async () => {
    const ev = JSON.stringify({ id: "tx-2", origin: "node-b", kind: "UptimeReward" });
    const { api } = streamsApi([sseResponse([`data: ${ev}\n\n`])]);
    const out = [];
    for await (const tx of api.transactions({ reconnect: false })) out.push(tx);
    expect(out[0]!.amount.toBaseUnits()).toBe("0");
  });

  it("decodes signal events and skips keep-alive comments", async () => {
    const sig = JSON.stringify({
      from: "node-x",
      to: "node-y",
      capabilities: ["exec"],
      payload_hex: "68656c6c6f",
      nonce: 1,
      id: "sig-1",
    });
    const { api } = streamsApi([sseResponse([`: keep-alive\n\n`, `data: ${sig}\n\n`])]);
    const out = [];
    for await (const s of api.signals({ reconnect: false })) out.push(s);
    expect(out).toHaveLength(1);
    expect(out[0]!.from).toBe("node-x");
    expect(out[0]!.capabilities).toEqual(["exec"]);
    // payload() decodes the hex back to bytes.
    expect(new TextDecoder().decode(out[0]!.payload())).toBe("hello");
  });

  it("throws CeStreamError on non-200 when reconnect is disabled", async () => {
    const { api } = streamsApi([sseResponse([], 503)]);
    await expect(async () => {
      for await (const _ of api.blocks({ reconnect: false })) void _;
    }).rejects.toBeInstanceOf(CeStreamError);
  });
});
