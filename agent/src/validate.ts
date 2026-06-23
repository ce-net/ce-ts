/**
 * App validation — exercises the CE stack end to end through the agent framework, so an agent (or
 * CI) can answer "does this actually work?" with a structured report instead of a vibe. Each step is
 * pass/fail with detail; failures carry the fault hint. Use `live` to run a real deploy→trace→kill
 * against a funded node, or leave it off for a safe, non-spending validation.
 */

import type { CeClient } from "./client.js";
import { doctor, trace, type DoctorReport } from "./debug.js";
import { buildTools } from "./tools.js";

export interface ValidationStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidationReport {
  ok: boolean;
  steps: ValidationStep[];
  doctor: DoctorReport;
  summary: string;
}

export interface ValidateOptions {
  /** Run a real deploy→trace→kill (spends credits). Requires a funded, Docker/WASM-capable node. */
  live?: boolean;
  /** WASM module CID (64-hex) for the live test. */
  wasmModule?: string;
}

export async function validate(client: CeClient, opts: ValidateOptions = {}): Promise<ValidationReport> {
  const steps: ValidationStep[] = [];
  const push = (name: string, ok: boolean, detail: string) => steps.push({ name, ok, detail });

  // 1. Health battery — node reachable, chain, wallet, peers, latency.
  const report = await doctor(client);
  push("doctor", report.healthy, report.summary);

  // 2. Tool-catalog self-check — every capability is a well-formed, self-describing tool.
  const tools = buildTools(client);
  const wellFormed = tools.every(
    (t) => !!t.name && t.description.length > 10 && (t.inputSchema as { type?: string }).type === "object",
  );
  push("tool-catalog", wellFormed, `${tools.length} tools, all self-describing`);

  // 3. Deploy path validates (dry-run, no spend).
  const dry = await client.deploy({ wasmModule: opts.wasmModule ?? "00".repeat(32), dryRun: true });
  push("deploy-dryrun", dry.ok, dry.ok ? "deploy spec validates" : dry.error.message);

  // 4. Fabric scoreboard reachable.
  const stats = await client.fabricStats();
  push(
    "fabric-stats",
    stats.ok,
    stats.ok ? `${stats.data.nodes} nodes, ${stats.data.cpu_cores} cores, ${stats.data.gpu_vram_gb}GB GPU` : stats.error.hint,
  );

  // 5. Optional real job lifecycle — the actual end-to-end app validation.
  if (opts.live && opts.wasmModule && report.healthy) {
    const dep = await client.deploy({ wasmModule: opts.wasmModule, cpuCores: 1, memMb: 64, durationSecs: 30, bid: "1" });
    if (dep.ok) {
      const jid = dep.data.job_id;
      const tr = await trace(client, jid);
      push("live-deploy", tr.found, `job ${jid} → ${tr.status ?? "?"} (${tr.diagnosis})`);
      const killed = await client.kill(jid);
      push("live-kill", killed.ok, killed.ok ? `stopped ${jid}` : killed.error.message);
    } else {
      push("live-deploy", false, `${dep.error.message} — ${dep.error.hint}`);
    }
  }

  const ok = steps.every((s) => s.ok);
  return {
    ok,
    steps,
    doctor: report,
    summary: ok ? "All validations passed." : `Failed: ${steps.filter((s) => !s.ok).map((s) => s.name).join(", ")}.`,
  };
}
