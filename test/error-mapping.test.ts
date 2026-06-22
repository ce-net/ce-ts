import { describe, it, expect } from "vitest";
import { errorFromStatus } from "../src/errors.js";
import {
  CeBadRequestError,
  CeAuthError,
  CeInsufficientFundsError,
  CeNotFoundError,
  CeRateLimitError,
  CePeerError,
  CeUnavailableError,
  CeTimeoutError,
  CeServerError,
  CeApiError,
} from "../src/errors.js";

describe("errorFromStatus mapping", () => {
  const cases: Array<[number, new (...a: never[]) => CeApiError]> = [
    [400, CeBadRequestError],
    [401, CeAuthError],
    [403, CeAuthError],
    [402, CeInsufficientFundsError],
    [404, CeNotFoundError],
    [429, CeRateLimitError],
    [502, CePeerError],
    [503, CeUnavailableError],
    [504, CeTimeoutError],
    [500, CeServerError],
    [507, CeServerError],
  ];

  for (const [status, klass] of cases) {
    it(`maps ${status} to ${klass.name}`, () => {
      const e = errorFromStatus(status, `HTTP ${status}`, "body");
      expect(e).toBeInstanceOf(klass);
      expect(e.status).toBe(status);
      expect(e.body).toBe("body");
    });
  }

  it("falls back to plain CeApiError for unmapped 4xx (418)", () => {
    const e = errorFromStatus(418, "teapot", "short and stout");
    expect(e).toBeInstanceOf(CeApiError);
    expect(e).not.toBeInstanceOf(CeServerError);
    expect(e.status).toBe(418);
  });

  it("carries retryAfter on 429", () => {
    const e = errorFromStatus(429, "slow down", "rate", { retryAfter: 12 });
    expect(e).toBeInstanceOf(CeRateLimitError);
    expect((e as CeRateLimitError).retryAfter).toBe(12);
  });

  it("carries requestId when provided", () => {
    const e = errorFromStatus(500, "boom", "stack", { requestId: "req-abc" });
    expect(e.requestId).toBe("req-abc");
  });

  it("instanceof narrowing works through the CeApiError base", () => {
    const e = errorFromStatus(402, "no funds", "");
    expect(e instanceof CeApiError).toBe(true);
    expect(e instanceof CeInsufficientFundsError).toBe(true);
  });
});
