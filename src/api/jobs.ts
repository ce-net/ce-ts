/** Jobs: list, get, bid, settle, kill, mesh-deploy (Docker + WASM), mesh-kill. */

import { Amount } from "../amount.js";
import type { Transport } from "../transport.js";
import type {
  BidSpec,
  Deployment,
  Job,
  RawDeployment,
  RawJob,
  SettleSpec,
  WasmDeploy,
} from "../types.js";

function optAmt(s: string | undefined | null): Amount | null {
  return s == null ? null : Amount.fromBaseUnits(s);
}

export function toJob(r: RawJob): Job {
  return {
    jobId: r.job_id,
    status: r.status,
    payer: r.payer ?? null,
    containerId: r.container_id ?? null,
    cost: optAmt(r.cost),
    bid: optAmt(r.bid),
  };
}

export function toDeployment(r: RawDeployment): Deployment {
  return { jobId: r.job_id, output: r.output ?? null };
}

/** Serialize a {@link BidSpec} into the node's `/jobs/bid` wire body. */
function bidBody(spec: BidSpec): Record<string, unknown> {
  return {
    image: spec.image,
    cmd: spec.cmd ?? [],
    env: spec.env ?? [],
    cpu_cores: spec.cpuCores,
    mem_mb: spec.memMb,
    duration_secs: spec.durationSecs,
    bid: spec.bid.toBaseUnits(),
  };
}

export class JobsApi {
  constructor(private readonly t: Transport) {}

  /** `GET /jobs` → all jobs this node tracks. */
  async list(): Promise<Job[]> {
    const r = await this.t.request<RawJob[]>("GET", "/jobs", "json", { auth: false });
    return (r ?? []).map(toJob);
  }

  /** `GET /jobs/:id` → one job. */
  async get(id: string): Promise<Job> {
    const r = await this.t.request<RawJob>(
      "GET",
      `/jobs/${encodeURIComponent(id)}`,
      "json",
      { auth: false },
    );
    return toJob(r);
  }

  /** `POST /jobs/bid` → job id. Idempotency-keyed (state-creating money op). */
  async bid(spec: BidSpec): Promise<string> {
    const r = await this.t.request<{ job_id: string }>("POST", "/jobs/bid", "json", {
      body: bidBody(spec),
      idempotent: true,
      maxRetries: 0,
    });
    return r.job_id;
  }

  /**
   * `POST /jobs/:id/settle` — payer co-signs settlement. The SDK forwards a
   * caller-built `payerSig` (128-hex) and `cost`; it performs no signing.
   */
  async settle(id: string, spec: SettleSpec): Promise<void> {
    await this.t.request<void>(
      "POST",
      `/jobs/${encodeURIComponent(id)}/settle`,
      "void",
      {
        body: { cost: spec.cost.toBaseUnits(), payer_sig: spec.payerSig },
      },
    );
  }

  /** `DELETE /jobs/:id` → force-stop a local job. */
  async kill(id: string): Promise<void> {
    await this.t.request<void>("DELETE", `/jobs/${encodeURIComponent(id)}`, "void");
  }

  /**
   * `POST /mesh-deploy` (Docker) → host-assigned job id. Directed placement on a
   * specific host over the mesh. `grant` is an opaque base64 capability chain.
   */
  async meshDeploy(nodeId: string, spec: BidSpec, grant?: string): Promise<string> {
    const body: Record<string, unknown> = {
      node_id: nodeId,
      ...bidBody(spec),
      inputs: [],
    };
    if (grant !== undefined) body["grant"] = grant;
    const r = await this.t.request<{ job_id: string; output?: string | null }>(
      "POST",
      "/mesh-deploy",
      "json",
      { body, idempotent: true, maxRetries: 0 },
    );
    return r.job_id;
  }

  /** `POST /mesh-deploy` (WASM) → `{ jobId, output }`. */
  async meshDeployWasm(opts: WasmDeploy): Promise<Deployment> {
    const body: Record<string, unknown> = {
      node_id: opts.nodeId,
      wasm_module: opts.wasmModule,
      wasm_entry: opts.wasmEntry,
      cmd: [],
      cpu_cores: opts.cpuCores,
      mem_mb: opts.memMb,
      duration_secs: opts.durationSecs,
      bid: opts.bid.toBaseUnits(),
      inputs: opts.inputs ?? [],
    };
    if (opts.grant !== undefined) body["grant"] = opts.grant;
    if (opts.hintMultiaddr !== undefined) body["hint_multiaddr"] = opts.hintMultiaddr;
    const r = await this.t.request<RawDeployment>("POST", "/mesh-deploy", "json", {
      body,
      idempotent: true,
      maxRetries: 0,
    });
    return toDeployment(r);
  }

  /** `POST /mesh-kill` → stop a mesh-deployed job on a specific host. */
  async meshKill(nodeId: string, jobId: string, grant?: string): Promise<void> {
    const body: Record<string, unknown> = { node_id: nodeId, job_id: jobId };
    if (grant !== undefined) body["grant"] = grant;
    await this.t.request<void>("POST", "/mesh-kill", "void", { body });
  }
}
