import { describe, it, expect } from "vitest";
import { CeClient, Amount } from "../src/index.js";

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Fetch mock keyed by `METHOD pathname` (query is on `path`). */
function mockClient(routes: Record<string, (body: string | undefined) => Response>): {
  ce: CeClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      method,
      path: url.pathname + url.search,
      headers: (init?.headers as Record<string, string>) ?? {},
      body,
    });
    const handler = routes[key];
    if (!handler) {
      return new Response(JSON.stringify({ error: `no route for ${key}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return handler(body);
  }) as unknown as typeof fetch;

  const ce = new CeClient({
    baseUrl: "http://node:8844",
    token: "tok",
    fetch: fetchImpl,
    maxRetries: 0,
  });
  return { ce, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("WalletApi", () => {
  it("balance() returns the /status breakdown with free+locked == total", async () => {
    const { ce } = mockClient({
      "GET /status": () =>
        json({
          node_id: "me",
          height: 7,
          difficulty: 0,
          balance: "12345000000000000000000",
          free: "11000000000000000000000",
          locked_channels: "1000000000000000000000",
          locked_bond: "345000000000000000000",
          bond: "345000000000000000000",
        }),
    });
    const b = await ce.wallet.balance();
    expect(b.total.toCredits()).toBe("12345");
    expect(b.free.toCredits()).toBe("11000");
    expect(b.lockedChannels.toCredits()).toBe("1000");
    expect(b.lockedBond.toCredits()).toBe("345");
    expect(b.bond.toCredits()).toBe("345");
    // Wallet math invariant.
    const sum = b.free.add(b.lockedChannels).add(b.lockedBond);
    expect(sum.eq(b.total)).toBe(true);
  });

  it("balance() falls back to zero locks on an older node returning only balance", async () => {
    const { ce } = mockClient({
      "GET /status": () =>
        json({ node_id: "me", height: 1, difficulty: 0, balance: "5000000000000000000" }),
    });
    const b = await ce.wallet.balance();
    expect(b.total.toCredits()).toBe("5");
    expect(b.lockedChannels.isZero()).toBe(true);
    expect(b.lockedBond.isZero()).toBe(true);
    // toNodeStatus derives free from balance when absent.
    expect(b.free.toCredits()).toBe("5");
  });

  it("transactions() decodes records and carries pagination on the query string", async () => {
    const { ce, calls } = mockClient({
      "GET /transactions/me": () =>
        json([
          {
            tx_id: "aa",
            height: 12,
            kind: "Transfer",
            amount: "2500000000000000000",
            counterparty: "peer",
            direction: "out",
          },
          {
            tx_id: "bb",
            height: 11,
            kind: "UptimeReward",
            amount: "1000000000000000000",
            counterparty: null,
            direction: "in",
          },
        ]),
    });
    const txs = await ce.wallet.transactions("me", { limit: 50, before: 13 });
    expect(txs).toHaveLength(2);
    expect(txs[0]!.amount.toCredits()).toBe("2.5");
    expect(txs[0]!.direction).toBe("out");
    expect(txs[1]!.counterparty).toBeNull();
    expect(calls[0]!.path).toContain("limit=50");
    expect(calls[0]!.path).toContain("before=13");
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
  });

  it("transfer() sends base-unit string and Bearer token", async () => {
    const { ce, calls } = mockClient({
      "POST /transfer": () => json({ tx_id: "tx9" }),
    });
    const id = await ce.wallet.transfer("peer", Amount.fromCredits("2.5"));
    expect(id).toBe("tx9");
    const sent = JSON.parse(calls[0]!.body!) as { to: string; amount: string };
    expect(sent.amount).toBe("2500000000000000000");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
  });

  it("openChannel() locks capacity via base-unit string", async () => {
    const { ce, calls } = mockClient({
      "POST /channels/open": () => json({ channel_id: "ch1" }, 201),
    });
    const ch = await ce.wallet.openChannel("host", Amount.fromWholeCredits(50), 100);
    expect(ch).toBe("ch1");
    const sent = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(sent["capacity"]).toBe("50000000000000000000");
    expect(sent["expiry_height"]).toBe(100);
  });

  it("closeChannel() passes the payer co-signature through unchanged", async () => {
    const { ce, calls } = mockClient({
      "POST /channels/ch1/close": () => json({ status: "submitted" }, 202),
    });
    await ce.wallet.closeChannel("ch1", Amount.fromWholeCredits(3), "deadbeef");
    const sent = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(sent["payer_sig"]).toBe("deadbeef");
    expect(sent["cumulative"]).toBe("3000000000000000000");
  });
});

describe("WalletApi.streamTransactions", () => {
  /** A fetch that returns an SSE body built from string chunks. */
  function sseClient(chunks: string[]): CeClient {
    const enc = new TextEncoder();
    const fetchImpl = (async () => {
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) {
            controller.enqueue(enc.encode(chunks[i]!));
            i++;
          } else {
            controller.close();
          }
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    return new CeClient({ baseUrl: "http://node:8844", token: "tok", fetch: fetchImpl });
  }

  it("maps stream events to wallet-relative TxRecords (out when self originates)", async () => {
    const ce = sseClient([
      'data: {"id":"t1","origin":"me","kind":"Transfer","amount":"5000000000000000000"}\n\n',
      'data: {"id":"t2","origin":"peer","kind":"JobSettle","amount":"1000000000000000000"}\n\n',
    ]);
    const out: { kind: string; dir: string; cp: string | null; amt: string }[] = [];
    for await (const tx of ce.wallet.streamTransactions("me", { reconnect: false })) {
      out.push({
        kind: tx.kind,
        dir: tx.direction,
        cp: tx.counterparty,
        amt: tx.amount.toCredits(),
      });
      if (out.length === 2) break;
    }
    expect(out[0]).toEqual({ kind: "Transfer", dir: "out", cp: null, amt: "5" });
    expect(out[1]).toEqual({ kind: "JobSettle", dir: "in", cp: "peer", amt: "1" });
  });
});

describe("TagsApi", () => {
  it("advertise() namespaces the tag as a `tag:` service", async () => {
    const { ce, calls } = mockClient({
      "POST /discovery/advertise": () => json({ status: "advertised" }),
    });
    await ce.tags.advertise("gpu");
    const sent = JSON.parse(calls[0]!.body!) as { service: string };
    expect(sent.service).toBe("tag:gpu");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
  });

  it("find() queries the namespaced service and returns providers", async () => {
    const { ce, calls } = mockClient({
      "GET /discovery/find/tag%3Amodel%3Allama-3-8b": () =>
        json({ service: "tag:model:llama-3-8b", providers: ["n1", "n2"] }),
    });
    const peers = await ce.tags.find("model:llama-3-8b");
    expect(peers).toEqual(["n1", "n2"]);
    expect(calls[0]!.path).toContain("tag%3Amodel%3Allama-3-8b");
  });

  it("findAll() intersects providers across tags", async () => {
    const { ce } = mockClient({
      "GET /discovery/find/tag%3Agpu": () =>
        json({ service: "tag:gpu", providers: ["n1", "n2", "n3"] }),
      "GET /discovery/find/tag%3Ainfer": () =>
        json({ service: "tag:infer", providers: ["n2", "n3", "n4"] }),
    });
    const peers = await ce.tags.findAll(["gpu", "infer"]);
    expect(peers).toEqual(["n2", "n3"]);
  });

  it("findAll([]) returns empty without any request", async () => {
    const { ce, calls } = mockClient({});
    expect(await ce.tags.findAll([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("findAny() returns a de-duplicated union", async () => {
    const { ce } = mockClient({
      "GET /discovery/find/tag%3Agpu": () =>
        json({ service: "tag:gpu", providers: ["n1", "n2"] }),
      "GET /discovery/find/tag%3Ainfer": () =>
        json({ service: "tag:infer", providers: ["n2", "n4"] }),
    });
    const peers = await ce.tags.findAny(["gpu", "infer"]);
    expect(peers).toEqual(["n1", "n2", "n4"]);
  });
});
