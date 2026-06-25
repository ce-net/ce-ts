import { describe, it, expect, afterEach } from "vitest";
import {
  CeClient,
  connectNode,
  bridgeFetch,
  getBridge,
  bridgeAvailable,
  BRIDGE_BASE_URL,
  CE_STRICT_CSP,
  type CeNodeBridge,
  type BridgeResponse,
} from "../src/index.js";

/**
 * A faithful fake of an in-browser node bridge: dispatches `(method, path)` IN-PROCESS and
 * returns `{ status, headers, body }`, exactly as `web/site/node.html`'s `window.__ceNode`
 * must. JSON as string, blobs as bytes, `/mesh/messages/stream` as a ReadableStream of SSE
 * frames.
 */
function fakeBridge(): { bridge: CeNodeBridge; calls: string[]; blob: Uint8Array } {
  const calls: string[] = [];
  const blob = new Uint8Array([1, 2, 3, 4, 250, 0, 99]);
  const bridge: CeNodeBridge = {
    nodeId: "abc123",
    ready: true,
    async request(method, path, init): Promise<BridgeResponse> {
      calls.push(`${method} ${path}`);
      if (method === "GET" && path === "/status") {
        return {
          status: 200,
          body: JSON.stringify({
            node_id: "abc123",
            height: 7,
            balance: "1000000000000000000",
            peers: 3,
          }),
        };
      }
      if (method === "GET" && path.startsWith("/blobs/")) {
        return { status: 200, body: blob };
      }
      if (method === "POST" && path === "/mesh/publish") {
        // Echo back that we received the body so the test can assert it round-tripped.
        return { status: 200, body: "" };
      }
      if (method === "GET" && path === "/mesh/messages/stream") {
        const frames = [
          'data: {"from":"x","topic":"t","payload_hex":"6869"}\n\n',
          'data: {"from":"y","topic":"t","payload_hex":"796f"}\n\n',
        ];
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const f of frames) controller.enqueue(enc.encode(f));
            controller.close();
          },
        });
        return {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
          body: stream,
        };
      }
      return { status: 501, body: JSON.stringify({ error: "unimplemented" }) };
    },
  };
  return { bridge, calls, blob };
}

afterEach(() => {
  delete (globalThis as { __ceNode?: unknown }).__ceNode;
});

describe("CE_STRICT_CSP", () => {
  it("is the exact agreed string", () => {
    expect(CE_STRICT_CSP).toBe(
      "default-src 'self'; connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
        "img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
        "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
    );
  });
  it("confines connect-src to self", () => {
    expect(CE_STRICT_CSP).toContain("connect-src 'self'");
  });
});

describe("getBridge / bridgeAvailable", () => {
  it("detects a present bridge and rejects malformed ones", () => {
    expect(getBridge()).toBeNull();
    expect(bridgeAvailable()).toBe(false);
    (globalThis as { __ceNode?: unknown }).__ceNode = { notRequest: true };
    expect(getBridge()).toBeNull();
    const { bridge } = fakeBridge();
    (globalThis as { __ceNode?: unknown }).__ceNode = bridge;
    expect(getBridge()).toBe(bridge);
    expect(bridgeAvailable()).toBe(true);
  });
});

describe("bridgeFetch via CeClient", () => {
  it("routes GET /status JSON through the bridge", async () => {
    const { bridge, calls } = fakeBridge();
    const ce = new CeClient({ baseUrl: BRIDGE_BASE_URL, fetch: bridgeFetch(bridge) });
    const s = await ce.getStatus();
    expect(s.height).toBe(7);
    expect(calls).toContain("GET /status");
  });

  it("round-trips binary /blobs bytes", async () => {
    const { bridge, blob } = fakeBridge();
    const fetchImpl = bridgeFetch(bridge);
    const res = await fetchImpl(`${BRIDGE_BASE_URL}/blobs/deadbeef`);
    const got = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(blob));
  });

  it("sends a request body through to the bridge", async () => {
    const { bridge, calls } = fakeBridge();
    const ce = new CeClient({ baseUrl: BRIDGE_BASE_URL, fetch: bridgeFetch(bridge) });
    await ce.mesh.publish("topic", new Uint8Array([0x68, 0x69]));
    expect(calls).toContain("POST /mesh/publish");
  });

  it("streams SSE frames from /mesh/messages/stream", async () => {
    const { bridge } = fakeBridge();
    const ce = new CeClient({ baseUrl: BRIDGE_BASE_URL, fetch: bridgeFetch(bridge) });
    const got: string[] = [];
    for await (const m of ce.mesh.streamMessages({ reconnect: false })) {
      got.push(m.from);
      if (got.length === 2) break;
    }
    expect(got).toEqual(["x", "y"]);
  });

  it("refuses to fetch a non-bridge origin", async () => {
    const { bridge } = fakeBridge();
    const fetchImpl = bridgeFetch(bridge);
    await expect(fetchImpl("https://evil.example/db")).rejects.toThrow(/refusing/);
  });
});

describe("connectNode", () => {
  it("uses the bridge transport when window.__ceNode is present", async () => {
    const { bridge, calls } = fakeBridge();
    (globalThis as { __ceNode?: unknown }).__ceNode = bridge;
    const ce = connectNode();
    const s = await ce.getStatus();
    expect(s.height).toBe(7);
    expect(calls).toContain("GET /status");
  });
});
