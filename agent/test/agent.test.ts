import { describe, expect, it } from "vitest";
import { CeClient } from "../src/client.js";
import { doctor, trace } from "../src/debug.js";
import { buildTools } from "../src/tools.js";

/** A mock fetch that routes by path to canned responses. */
function mockFetch(routes: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    const path = new URL(u).pathname;
    const r = routes[path];
    if (!r) return new Response("not found", { status: 404 });
    const status = r.status ?? 200;
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(status >= 400 ? String(r.body) : body, { status });
  }) as unknown as typeof fetch;
}

describe("CeClient", () => {
  it("returns structured data on success", async () => {
    const ce = new CeClient({
      fetch: mockFetch({ "/status": { body: { node_id: "ab", height: 7, balance: "100" } } }),
    });
    const r = await ce.status();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.height).toBe(7);
  });

  it("maps 402 to INSUFFICIENT_CREDITS with a hint, never throws", async () => {
    const ce = new CeClient({ fetch: mockFetch({ "/jobs/bid": { status: 402, body: "no balance" } }) });
    const r = await ce.deploy({ image: "alpine:latest" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INSUFFICIENT_CREDITS");
      expect(r.error.hint.length).toBeGreaterThan(0);
      expect(r.error.retriable).toBe(false);
    }
  });

  it("maps a guardian 403 to GUARDIAN_DENIED", async () => {
    const ce = new CeClient({
      fetch: mockFetch({ "/mesh-deploy": { status: 403, body: "workload denied by guardian: cryptominer" } }),
    });
    const r = await ce.deploy({ image: "x", host: "deadbeef" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("GUARDIAN_DENIED");
  });

  it("dryRun validates without spending and catches missing artifact", async () => {
    const ce = new CeClient({ fetch: mockFetch({}) });
    const bad = await ce.deploy({ dryRun: true });
    expect(bad.ok).toBe(false);
    const good = await ce.deploy({ dryRun: true, image: "alpine" });
    expect(good.ok).toBe(true);
  });
});

describe("debug", () => {
  it("doctor reports a failing node with remediation", async () => {
    const ce = new CeClient({ fetch: mockFetch({ "/health": { status: 503, body: "down" } }) });
    const rep = await doctor(ce);
    expect(rep.healthy).toBe(false);
    expect(rep.checks[0].status).toBe("fail");
    expect(rep.checks[0].remediation).toBeTruthy();
  });

  it("doctor passes a healthy node", async () => {
    const ce = new CeClient({
      fetch: mockFetch({
        "/health": { body: "ok" },
        "/status": { body: { node_id: "ab", height: 10, balance: "5" } },
        "/atlas": { body: [{ node_id: "x", cpu_cores: 4, mem_mb: 8000, running_jobs: 0, last_seen_secs: 1, tags: [] }] },
        "/netgraph": { body: [{ peer: "p", rtt_ms: 12, samples: 3, last_seen_secs: 1 }] },
      }),
    });
    const rep = await doctor(ce);
    expect(rep.healthy).toBe(true);
  });

  it("trace diagnoses a missing job", async () => {
    const ce = new CeClient({ fetch: mockFetch({ "/jobs/abc": { status: 404, body: "no such job" } }) });
    const t = await trace(ce, "abc");
    expect(t.found).toBe(false);
    expect(t.diagnosis.length).toBeGreaterThan(0);
  });
});

describe("tool catalog", () => {
  it("exposes self-describing tools that run", async () => {
    const ce = new CeClient({ fetch: mockFetch({ "/status": { body: { node_id: "ab", height: 1, balance: "0" } } }) });
    const tools = buildTools(ce);
    const names = tools.map((t) => t.name);
    expect(names).toContain("ce_deploy");
    expect(names).toContain("ce_doctor");
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema).toHaveProperty("type", "object");
    }
    const status = tools.find((t) => t.name === "ce_status")!;
    const res = (await status.run({})) as { ok: boolean };
    expect(res.ok).toBe(true);
  });
});
