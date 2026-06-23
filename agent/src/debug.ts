/**
 * Debugging primitives — the part that matters most. `doctor` runs a battery of health checks and
 * returns, for each, a status plus the exact remediation. `trace` follows a single job's lifecycle
 * so an agent can see *where* it stalled (accepted? bid? launched? settled?) instead of guessing.
 */

import type { CeClient } from "./client.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do if this is not a pass. */
  remediation?: string;
}

export interface DoctorReport {
  healthy: boolean;
  checks: Check[];
  summary: string;
}

/** Probe the node + fabric and report what is wrong and how to fix it. */
export async function doctor(client: CeClient): Promise<DoctorReport> {
  const checks: Check[] = [];

  const health = await client.health();
  checks.push(
    health.ok
      ? { name: "node.reachable", status: "pass", detail: `node responding at ${client.nodeUrl}` }
      : {
          name: "node.reachable",
          status: "fail",
          detail: health.error.message,
          remediation: health.error.hint,
        },
  );

  // If the node is down, the rest cannot run — return early with a clear cause.
  if (!health.ok) {
    return { healthy: false, checks, summary: "Node is unreachable — fix that first." };
  }

  const status = await client.status();
  if (status.ok) {
    checks.push({
      name: "chain.synced",
      status: status.data.height > 0 ? "pass" : "warn",
      detail: `height ${status.data.height}, balance ${status.data.balance}`,
      remediation: status.data.height === 0 ? "Node has no chain yet — give it time to sync or mine." : undefined,
    });
    checks.push({
      name: "wallet.funded",
      status: Number(status.data.balance) > 0 ? "pass" : "warn",
      detail: `balance ${status.data.balance}`,
      remediation:
        Number(status.data.balance) > 0 ? undefined : "Zero balance — mine, or receive a transfer, before paying for jobs.",
    });
  } else {
    checks.push({ name: "chain.synced", status: "fail", detail: status.error.message, remediation: status.error.hint });
  }

  const atlas = await client.atlas();
  checks.push(
    atlas.ok
      ? {
          name: "mesh.peers",
          status: atlas.data.length > 0 ? "pass" : "warn",
          detail: `${atlas.data.length} peer(s) in the atlas`,
          remediation: atlas.data.length === 0 ? "No peers yet — check bootstrap/relay connectivity (docs/deployment.md)." : undefined,
        }
      : { name: "mesh.peers", status: "warn", detail: atlas.error.message, remediation: atlas.error.hint },
  );

  const net = await client.netgraph();
  if (net.ok) {
    const measured = net.data.filter((e) => e.samples > 0).length;
    checks.push({
      name: "fabric.latency",
      status: measured > 0 ? "pass" : "warn",
      detail: `${measured} measured latency edge(s)`,
      remediation: measured === 0 ? "No RTT samples yet — ping needs a few seconds after peers connect." : undefined,
    });
  }

  const healthy = checks.every((c) => c.status !== "fail");
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  return {
    healthy,
    checks,
    summary: healthy
      ? warns === 0
        ? "All checks passed."
        : `Operational with ${warns} warning(s).`
      : `${fails} check(s) failing — see remediation.`,
  };
}

export interface TraceStep {
  stage: string;
  observed: boolean;
  detail: string;
}

export interface JobTrace {
  jobId: string;
  found: boolean;
  status?: string;
  steps: TraceStep[];
  diagnosis: string;
}

/**
 * Follow a job through its lifecycle and explain where it is. Stages: known to node → has a status →
 * running/settled. When a job is missing or stuck, the diagnosis points at the likely cause.
 */
export async function trace(client: CeClient, jobId: string): Promise<JobTrace> {
  const job = await client.job(jobId);
  if (!job.ok) {
    return {
      jobId,
      found: false,
      steps: [{ stage: "known-to-node", observed: false, detail: job.error.message }],
      diagnosis: job.error.hint,
    };
  }
  const status = String(job.data.status ?? "unknown");
  const steps: TraceStep[] = [
    { stage: "known-to-node", observed: true, detail: `job present, status=${status}` },
    { stage: "running", observed: /run/i.test(status), detail: status },
    { stage: "settled", observed: /settl/i.test(status), detail: status },
  ];
  let diagnosis: string;
  if (/run/i.test(status)) diagnosis = "Job is running. Stream output via the node, or `ce_kill` to stop it.";
  else if (/settl/i.test(status)) diagnosis = "Job completed and settled. Final cost is recorded on-chain.";
  else if (/fail|error|expire/i.test(status)) diagnosis = "Job failed/expired. Inspect node logs (`ce logs`); a guardian deny or staging error is common.";
  else diagnosis = `Job is in '${status}'. If it is stuck here, check the host's logs and the payer balance.`;
  return { jobId, found: true, status, steps, diagnosis };
}
