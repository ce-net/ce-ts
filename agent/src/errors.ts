/**
 * The fault taxonomy — the heart of "debugging is easy". Every failure an agent can hit maps to a
 * stable code with a human/agent-readable message AND a `hint`: the concrete next action to resolve
 * it. Agents should branch on `code`, surface `message`, and act on `hint`.
 */

export type CeFaultCode =
  | "NODE_UNREACHABLE"
  | "AUTH_REQUIRED"
  | "CAPABILITY_DENIED"
  | "GUARDIAN_DENIED"
  | "INSUFFICIENT_CREDITS"
  | "NO_HOST"
  | "DOCKER_UNAVAILABLE"
  | "JOB_NOT_FOUND"
  | "TIMEOUT"
  | "BAD_REQUEST"
  | "RATE_LIMITED"
  | "UNKNOWN";

export interface CeFault {
  code: CeFaultCode;
  /** What went wrong, in plain language. */
  message: string;
  /** The concrete next action an agent (or human) should take to fix it. */
  hint: string;
  /** Whether retrying the same call unchanged could succeed (transient failure). */
  retriable: boolean;
  /** HTTP status, if the fault came from the node API. */
  status?: number;
  /** The underlying error, for deep debugging. */
  cause?: unknown;
}

const HINTS: Record<CeFaultCode, { hint: string; retriable: boolean }> = {
  NODE_UNREACHABLE: {
    hint: "Is the node running? Start it with `ce start`, then confirm `GET /health` on the node URL. Check the nodeUrl and that nothing blocks the port (default 8844).",
    retriable: true,
  },
  AUTH_REQUIRED: {
    hint: "This endpoint needs the node API token. Pass `token` to the client (the node prints/saves it under the data dir). Local loopback calls usually do not need it.",
    retriable: false,
  },
  CAPABILITY_DENIED: {
    hint: "The action needs a capability you do not hold. Get the resource owner to `ce grant <your-node-id> --can <ability>` and present the chain. See docs/capabilities.md.",
    retriable: false,
  },
  GUARDIAN_DENIED: {
    hint: "The pre-execution guardian refused this workload (e.g. a banned category). Inspect the deny reason; the policy lives in the ce-guardian app, not the node. See docs/guardian.md.",
    retriable: false,
  },
  INSUFFICIENT_CREDITS: {
    hint: "The payer has no credits to escrow this job. Mine (run a node), receive a transfer, or lower the bid. Check balance with the `ce_status` tool.",
    retriable: false,
  },
  NO_HOST: {
    hint: "No peer in the atlas matches the requested tags/resources. Loosen the filter, wait for hosts to join, or check `ce_atlas`/`ce_fabric_stats` for what is actually available.",
    retriable: true,
  },
  DOCKER_UNAVAILABLE: {
    hint: "This node has no Docker socket, so container jobs are disabled. Start Docker, or target a WASM workload (which every node can run).",
    retriable: false,
  },
  JOB_NOT_FOUND: {
    hint: "No job with that id on this node. List jobs with `ce_jobs`; the id may be stale, on another host, or already settled.",
    retriable: false,
  },
  TIMEOUT: {
    hint: "The node did not respond in time. It may be busy, mid-sync, or unreachable over the mesh. Retry with a longer timeout, or check `ce_doctor`.",
    retriable: true,
  },
  BAD_REQUEST: {
    hint: "The request was malformed. Re-check the tool arguments against its input schema (amounts are decimal strings, ids are 64-hex).",
    retriable: false,
  },
  RATE_LIMITED: {
    hint: "Too many requests. Back off and retry after a short delay.",
    retriable: true,
  },
  UNKNOWN: {
    hint: "Unexpected failure. Inspect `cause`, run `ce_doctor`, and check the node logs (`ce logs`).",
    retriable: true,
  },
};

export function fault(code: CeFaultCode, message: string, extra?: Partial<CeFault>): CeFault {
  const base = HINTS[code];
  return {
    code,
    message,
    hint: extra?.hint ?? base.hint,
    retriable: extra?.retriable ?? base.retriable,
    status: extra?.status,
    cause: extra?.cause,
  };
}

/** Map a node HTTP response to a fault. The node uses standard codes: 402 = no credits, 403 = cap. */
export function faultFromHttp(status: number, body: string): CeFault {
  const msg = body.slice(0, 400) || `HTTP ${status}`;
  if (status === 401) return fault("AUTH_REQUIRED", msg, { status });
  if (status === 402) return fault("INSUFFICIENT_CREDITS", msg, { status });
  if (status === 403) {
    const code = /guardian/i.test(body) ? "GUARDIAN_DENIED" : "CAPABILITY_DENIED";
    return fault(code, msg, { status });
  }
  if (status === 404) return fault("JOB_NOT_FOUND", msg, { status });
  if (status === 400 || status === 422) return fault("BAD_REQUEST", msg, { status });
  if (status === 429) return fault("RATE_LIMITED", msg, { status });
  if (status === 503) {
    const code = /docker/i.test(body) ? "DOCKER_UNAVAILABLE" : "NODE_UNREACHABLE";
    return fault(code, msg, { status });
  }
  return fault("UNKNOWN", msg, { status });
}

/** Map a thrown fetch/network error to a fault. */
export function faultFromThrow(e: unknown): CeFault {
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort|timeout/i.test(msg)) return fault("TIMEOUT", msg, { cause: e });
  return fault("NODE_UNREACHABLE", msg, { cause: e });
}
