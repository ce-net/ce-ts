/**
 * CeError hierarchy. The node returns `{ "error": "..." }` bodies on failure; the
 * transport maps HTTP status codes to these subclasses. `instanceof` narrowing is the
 * documented pattern. The 402/502/504 cases are first-class because they are
 * load-bearing in CE flows (bid funding, mesh placement).
 */

/** Base class for every error this SDK throws. */
export class CeError extends Error {
  override readonly name: string = "CeError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // Restore prototype chain for transpiled-to-ES5 consumers.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Any HTTP non-2xx response from the node. */
export class CeApiError extends CeError {
  override readonly name: string = "CeApiError";
  /** HTTP status code. */
  readonly status: number;
  /** Parsed `error` field, or the raw body text. */
  readonly body: string;
  /** Correlation id from a response header, if the node provided one. */
  readonly requestId?: string;

  constructor(
    message: string,
    status: number,
    body: string,
    requestId?: string,
  ) {
    super(message);
    this.status = status;
    this.body = body;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

/** 400 Bad Request — malformed input or invalid format. */
export class CeBadRequestError extends CeApiError {
  override readonly name = "CeBadRequestError";
}

/** 401 / 403 — missing or invalid API token. */
export class CeAuthError extends CeApiError {
  override readonly name = "CeAuthError";
}

/** 402 Payment Required — insufficient balance (bid / transfer / channel open). */
export class CeInsufficientFundsError extends CeApiError {
  override readonly name = "CeInsufficientFundsError";
}

/** 404 Not Found. */
export class CeNotFoundError extends CeApiError {
  override readonly name = "CeNotFoundError";
}

/** 429 Too Many Requests. */
export class CeRateLimitError extends CeApiError {
  override readonly name = "CeRateLimitError";
  /** Seconds to wait, parsed from `Retry-After`, if present. */
  readonly retryAfter?: number;
  constructor(
    message: string,
    status: number,
    body: string,
    retryAfter?: number,
    requestId?: string,
  ) {
    super(message, status, body, requestId);
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/** 502 Bad Gateway — a mesh RPC peer rejected the request. */
export class CePeerError extends CeApiError {
  override readonly name = "CePeerError";
}

/** 503 Service Unavailable — Docker (or another local dependency) is unavailable. */
export class CeUnavailableError extends CeApiError {
  override readonly name = "CeUnavailableError";
}

/** 504 Gateway Timeout — a mesh RPC timed out. */
export class CeTimeoutError extends CeApiError {
  override readonly name = "CeTimeoutError";
}

/** Other 5xx. */
export class CeServerError extends CeApiError {
  override readonly name = "CeServerError";
}

/** Network / DNS / abort / client-side timeout — no HTTP response received. */
export class CeConnectionError extends CeError {
  override readonly name = "CeConnectionError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** SSE decode or disconnect failure. */
export class CeStreamError extends CeError {
  override readonly name = "CeStreamError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Map an HTTP status + body to the right {@link CeApiError} subclass.
 * `retryAfter` is the parsed `Retry-After` header in seconds (for 429).
 */
export function errorFromStatus(
  status: number,
  message: string,
  body: string,
  opts?: { retryAfter?: number; requestId?: string },
): CeApiError {
  const requestId = opts?.requestId;
  switch (status) {
    case 400:
      return new CeBadRequestError(message, status, body, requestId);
    case 401:
    case 403:
      return new CeAuthError(message, status, body, requestId);
    case 402:
      return new CeInsufficientFundsError(message, status, body, requestId);
    case 404:
      return new CeNotFoundError(message, status, body, requestId);
    case 429:
      return new CeRateLimitError(message, status, body, opts?.retryAfter, requestId);
    case 502:
      return new CePeerError(message, status, body, requestId);
    case 503:
      return new CeUnavailableError(message, status, body, requestId);
    case 504:
      return new CeTimeoutError(message, status, body, requestId);
    default:
      if (status >= 500) return new CeServerError(message, status, body, requestId);
      return new CeApiError(message, status, body, requestId);
  }
}
