/**
 * The tool catalog — every CE capability as a self-describing, agent-callable tool. Each tool has a
 * name, a description written for an agent, a JSON-schema for its inputs, and a `run` that returns a
 * plain JSON result (data on success, or `{ error }` carrying the fault + fix-it hint). This registry
 * is framework-agnostic: `mcp.ts` exposes it over MCP, but you can also call `run` directly.
 */

import type { CeClient } from "./client.js";
import { doctor, trace } from "./debug.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });

/** Build the tool catalog bound to a client. */
export function buildTools(client: CeClient): ToolDef[] {
  // Unwrap a Result into a flat JSON value an agent can read directly.
  const out = async (p: Promise<{ ok: boolean; data?: unknown; error?: unknown }>) => {
    const r = await p;
    return r.ok ? { ok: true, ...(typeof r.data === "object" && r.data ? r.data : { data: r.data }) } : { ok: false, error: r.error };
  };

  return [
    {
      name: "ce_status",
      description: "Node identity, chain height, and credit balance. Start here to confirm the node is alive and funded.",
      inputSchema: obj({}),
      run: () => out(client.status()),
    },
    {
      name: "ce_fabric_stats",
      description: "The whole-network scoreboard: nodes, CPU cores, GPU count + VRAM, memory, storage, a measured perf score, and mesh latency. Use to see what compute exists before placing work.",
      inputSchema: obj({}),
      run: () => out(client.fabricStats()),
    },
    {
      name: "ce_atlas",
      description: "Per-peer capacity (cores, memory, running jobs, tags). Use to pick a host by capability.",
      inputSchema: obj({}),
      run: () => out(client.atlas()),
    },
    {
      name: "ce_netgraph",
      description: "Measured round-trip latency edges from this node to its peers — the foundation for latency-aware placement.",
      inputSchema: obj({}),
      run: () => out(client.netgraph()),
    },
    {
      name: "ce_deploy",
      description: "Run a workload (container image or WASM module) on the mesh. Pass host to target a specific node, omit to broadcast a bid. Set dryRun to validate without spending. Returns a job_id.",
      inputSchema: obj(
        {
          image: str("Container image, e.g. 'alpine:latest'. Mutually exclusive with wasmModule."),
          wasmModule: str("WASM module CID (64-hex)."),
          cmd: { type: "array", items: { type: "string" }, description: "Command + args for the container." },
          cpuCores: num("CPU cores to request (default 1)."),
          memMb: num("Memory in MB (default 256)."),
          durationSecs: num("Max runtime in seconds (default 3600)."),
          bid: str("Bid in credits as a decimal string (default '1')."),
          host: str("Target host node id (64-hex). Omit to broadcast."),
          dryRun: bool("Validate only; do not deploy or spend."),
        },
        [],
      ),
      run: (a) => out(client.deploy(a as never)),
    },
    {
      name: "ce_jobs",
      description: "List jobs known to this node with their status.",
      inputSchema: obj({}),
      run: () => out(client.jobs()),
    },
    {
      name: "ce_kill",
      description: "Stop a running job by id.",
      inputSchema: obj({ jobId: str("The job id (64-hex).") }, ["jobId"]),
      run: (a) => out(client.kill(String(a.jobId))),
    },
    {
      name: "ce_transfer",
      description: "Transfer credits to another node. Amount is a decimal credit string.",
      inputSchema: obj({ to: str("Recipient node id (64-hex)."), amount: str("Credits, decimal string.") }, ["to", "amount"]),
      run: (a) => out(client.transfer(String(a.to), String(a.amount))),
    },
    {
      name: "ce_doctor",
      description: "DEBUG: run a battery of health checks (node reachable, chain synced, wallet funded, peers, latency) and return each status with exact remediation. Run this first when anything fails.",
      inputSchema: obj({}),
      run: () => doctor(client),
    },
    {
      name: "ce_trace",
      description: "DEBUG: follow one job through its lifecycle (known-to-node → running → settled) and diagnose where it stalled. Use when a deploy did not produce the expected result.",
      inputSchema: obj({ jobId: str("The job id to trace (64-hex).") }, ["jobId"]),
      run: (a) => trace(client, String(a.jobId)),
    },
  ];
}
