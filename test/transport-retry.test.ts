import { describe, it, expect } from "vitest";
import { Transport } from "../src/transport.js";
import {
  CeInsufficientFundsError,
  CeAuthError,
  CeBadRequestError,
  CeServerError,
  CeConnectionError,
} from "../src/errors.js";

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(
  responses: Array<Response | (() => Response | Promise<Response>) | Error>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r();
    return r;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Transport retry + error mapping", () => {
  it("retries on 503 then succeeds", async () => {
    const { fetch, calls } = mockFetch([
      json({ error: "docker down" }, 503),
      json({ ok: true }, 200),
    ]);
    const t = new Transport({
      baseUrl: "http://node",
      fetch,
      timeoutMs: 1000,
      maxRetries: 2,
    });
    const res = await t.request<{ ok: boolean }>("GET", "/x", "json", { auth: false });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry on 402 (insufficient funds)", async () => {
    const { fetch, calls } = mockFetch([
      json({ error: "insufficient balance" }, 402),
      json({ ok: true }, 200),
    ]);
    const t = new Transport({
      baseUrl: "http://node",
      fetch,
      timeoutMs: 1000,
      maxRetries: 3,
    });
    await expect(
      t.request("POST", "/transfer", "json", { body: { to: "x", amount: "1" } }),
    ).rejects.toBeInstanceOf(CeInsufficientFundsError);
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry on 400/401", async () => {
    {
      const { fetch } = mockFetch([json({ error: "bad" }, 400)]);
      const t = new Transport({ baseUrl: "http://n", fetch, timeoutMs: 1000, maxRetries: 3 });
      await expect(t.request("POST", "/x", "json", {})).rejects.toBeInstanceOf(
        CeBadRequestError,
      );
    }
    {
      const { fetch } = mockFetch([json({ error: "nope" }, 401)]);
      const t = new Transport({ baseUrl: "http://n", fetch, timeoutMs: 1000, maxRetries: 3 });
      await expect(t.request("POST", "/x", "json", {})).rejects.toBeInstanceOf(CeAuthError);
    }
  });

  it("attaches Authorization on non-GET and omits it on GET", async () => {
    const { fetch, calls } = mockFetch([json({ ok: true }), json({ ok: true })]);
    const t = new Transport({
      baseUrl: "http://node",
      fetch,
      token: "secret-token",
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await t.request("GET", "/status", "json", {});
    await t.request("POST", "/transfer", "json", { body: {} });
    const getHeaders = calls[0]!.init.headers as Record<string, string>;
    const postHeaders = calls[1]!.init.headers as Record<string, string>;
    expect(getHeaders["Authorization"]).toBeUndefined();
    expect(postHeaders["Authorization"]).toBe("Bearer secret-token");
  });

  it("adds an Idempotency-Key on idempotent requests", async () => {
    const { fetch, calls } = mockFetch([json({ ok: true })]);
    const t = new Transport({ baseUrl: "http://n", fetch, timeoutMs: 1000, maxRetries: 0 });
    await t.request("POST", "/transfer", "json", { body: {}, idempotent: true });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
  });

  it("maps a network error to CeConnectionError after exhausting retries", async () => {
    const { fetch, calls } = mockFetch([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    const t = new Transport({ baseUrl: "http://n", fetch, timeoutMs: 1000, maxRetries: 1 });
    await expect(t.request("GET", "/x", "json", { auth: false })).rejects.toBeInstanceOf(
      CeConnectionError,
    );
    expect(calls).toHaveLength(2);
  });

  it("maps generic 500 to CeServerError", async () => {
    const { fetch } = mockFetch([json({ error: "boom" }, 500)]);
    const t = new Transport({ baseUrl: "http://n", fetch, timeoutMs: 1000, maxRetries: 0 });
    await expect(t.request("GET", "/x", "json", { auth: false })).rejects.toBeInstanceOf(
      CeServerError,
    );
  });
});
