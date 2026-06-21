import { describe, it, expect } from "vitest";
import { CeClient, Amount } from "../src/index.js";

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * A fetch mock that records calls and returns canned responses keyed by
 * `METHOD path`. Path is the pathname (no host).
 */
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

describe("CeClient endpoint coverage (fetch-mock)", () => {
  it("GET /status decodes amounts as Amount", async () => {
    const { ce, calls } = mockClient({
      "GET /status": () =>
        json({
          node_id: "abc",
          height: 7,
          difficulty: 0,
          balance: "1500000000000000000",
          circulating_supply: "1000000000000000000000",
          burned_total: "0",
          bond: "0",
          weight: 3,
          free: "1400000000000000000",
          locked_channels: "100000000000000000",
          locked_bond: "0",
        }),
    });
    const s = await ce.status.status();
    expect(s.nodeId).toBe("abc");
    expect(s.height).toBe(7);
    expect(s.balance).toBeInstanceOf(Amount);
    expect(s.balance.toCredits()).toBe("1.5");
    expect(s.circulatingSupply.toCredits()).toBe("1000");
    // Balance breakdown (Wave-0).
    expect(s.free.toCredits()).toBe("1.4");
    expect(s.lockedChannels.toCredits()).toBe("0.1");
    expect(s.lockedBond.toCredits()).toBe("0");
    // GET is unauthenticated.
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
  });

  it("GET /transactions/:node_id decodes records and passes pagination query", async () => {
    const { ce, calls } = mockClient({
      "GET /transactions/node": () =>
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
    const txs = await ce.transactions("node", { limit: 50, before: 13 });
    expect(txs).toHaveLength(2);
    expect(txs[0]!.txId).toBe("aa");
    expect(txs[0]!.amount.toCredits()).toBe("2.5");
    expect(txs[0]!.counterparty).toBe("peer");
    expect(txs[0]!.direction).toBe("out");
    expect(txs[1]!.counterparty).toBeNull();
    // Pagination is carried on the request URL query string.
    expect(calls[0]!.path).toContain("limit=50");
    expect(calls[0]!.path).toContain("before=13");
    expect(calls[0]!.method).toBe("GET");
    // Unauthenticated read.
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
  });

  it("POST /transfer sends base-unit string and Bearer token", async () => {
    const { ce, calls } = mockClient({
      "POST /transfer": () => json({ tx_id: "tx123" }),
    });
    const txId = await ce.transfer("recipient", Amount.fromCredits("2.5"));
    expect(txId).toBe("tx123");
    const sent = JSON.parse(calls[0]!.body!) as { to: string; amount: string };
    expect(sent.to).toBe("recipient");
    expect(sent.amount).toBe("2500000000000000000");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
  });

  it("POST /jobs/bid serializes the BidSpec snake_case wire body", async () => {
    const { ce, calls } = mockClient({
      "POST /jobs/bid": () => json({ job_id: "job1" }, 201),
    });
    const id = await ce.jobs.bid({
      image: "alpine:latest",
      cmd: ["echo", "hi"],
      cpuCores: 2,
      memMb: 512,
      durationSecs: 60,
      bid: Amount.fromWholeCredits(10),
    });
    expect(id).toBe("job1");
    const sent = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(sent["cpu_cores"]).toBe(2);
    expect(sent["mem_mb"]).toBe(512);
    expect(sent["duration_secs"]).toBe(60);
    expect(sent["bid"]).toBe("10000000000000000000");
  });

  it("GET /jobs/:id decodes optional Amount fields", async () => {
    const { ce } = mockClient({
      "GET /jobs/job1": () =>
        json({
          job_id: "job1",
          status: "settled",
          payer: "p",
          cost: "5000000000000000000",
          bid: "10000000000000000000",
        }),
    });
    const job = await ce.jobs.get("job1");
    expect(job.status).toBe("settled");
    expect(job.cost?.toCredits()).toBe("5");
    expect(job.bid?.toCredits()).toBe("10");
    expect(job.containerId).toBeNull();
  });

  it("DELETE /jobs/:id sends a DELETE", async () => {
    const { ce, calls } = mockClient({
      "DELETE /jobs/job1": () => new Response(null, { status: 204 }),
    });
    await ce.jobs.kill("job1");
    expect(calls[0]!.method).toBe("DELETE");
  });

  it("mesh send/request encode payloads as hex", async () => {
    const { ce, calls } = mockClient({
      "POST /mesh/send": () => json({ status: "delivered" }),
      "POST /mesh/request": () => json({ payload_hex: "776f726c64" }), // "world"
    });
    await ce.mesh.send("peer", "topic", new Uint8Array([0xde, 0xad]));
    const sent = JSON.parse(calls[0]!.body!) as { payload_hex: string };
    expect(sent.payload_hex).toBe("dead");

    const reply = await ce.mesh.request("peer", "topic", new Uint8Array([1]), 1000);
    expect(new TextDecoder().decode(reply)).toBe("world");
  });

  it("names.resolve returns null on 404", async () => {
    const { ce } = mockClient({
      "GET /names/missing": () => json({ error: "not found" }, 404),
    });
    expect(await ce.names.resolve("missing")).toBeNull();
  });

  it("channels.open locks capacity via base-unit string", async () => {
    const { ce, calls } = mockClient({
      "POST /channels/open": () => json({ channel_id: "ch1" }, 201),
    });
    const ch = await ce.channels.open("host", Amount.fromWholeCredits(50), 100);
    expect(ch).toBe("ch1");
    const sent = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(sent["capacity"]).toBe("50000000000000000000");
    expect(sent["expiry_height"]).toBe(100);
  });

  it("history exposes isNewcomer/deliveredWork helpers", async () => {
    const { ce } = mockClient({
      "GET /history/node": () =>
        json({
          node_id: "node",
          jobs_hosted: 3,
          jobs_paid: 1,
          heartbeats_hosted: 2,
          heartbeats_paid: 0,
          expiries: 0,
          earned: "1000000000000000000",
          spent: "500000000000000000",
          first_height: 0,
          last_height: 0,
        }),
    });
    const h = await ce.history("node");
    expect(h.isNewcomer()).toBe(true);
    expect(h.deliveredWork()).toBe(5);
    expect(h.earned.toCredits()).toBe("1");
  });
});
