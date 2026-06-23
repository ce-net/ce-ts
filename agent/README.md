# @ce-net/agent

**CE for AI agents.** Every CE capability as a clean, self-describing tool an agent can call — with
**debugging built in as a first-class feature**, not an afterthought. Ships an MCP server so Claude
Code / Claude Desktop (or any agent host) can orchestrate the network directly.

## Why this exists

CE is the substrate; **AI agents are meant to be its central orchestrators.** For that, two things
have to be true:

1. **Tools are trivial to call.** One typed tool per capability — `ce_status`, `ce_fabric_stats`,
   `ce_atlas`, `ce_netgraph`, `ce_deploy`, `ce_jobs`, `ce_kill`, `ce_transfer` — each self-describing
   with a JSON-schema, returning plain JSON.
2. **Debugging is easy.** Every failure is a typed `CeFault` with a stable `code`, a plain `message`,
   and a **`hint` — the concrete next action to fix it**. Plus two debug tools:
   - **`ce_doctor`** — a battery of health checks (node reachable, chain synced, wallet funded, peers,
     latency), each with exact remediation. Run it first when anything fails.
   - **`ce_trace`** — follows one job through its lifecycle (known-to-node → running → settled) and
     diagnoses *where* it stalled.

No raw HTTP, no stack traces, no guessing — an agent gets a result or a fault that tells it what to do.

## Use it as an MCP server

Build, then point your agent host at the stdio server:

```bash
npm install && npm run build
```

Claude Code / Claude Desktop config:

```json
{
  "mcpServers": {
    "ce": {
      "command": "node",
      "args": ["/path/to/ce-ts/agent/dist/mcp-stdio.js"],
      "env": {
        "CE_NODE_URL": "http://localhost:8844",
        "CE_HUB_URL": "https://ce-net.com/hub"
      }
    }
  }
}
```

The agent now sees the CE tools and can call them — deploy a container, read the fabric scoreboard,
trace a stuck job — all with structured, hint-bearing errors.

## Use it as a library

```ts
import { CeClient, doctor, trace, buildTools } from "@ce-net/agent";

const ce = new CeClient({ nodeUrl: "http://localhost:8844" });

const stats = await ce.fabricStats();
if (!stats.ok) console.error(stats.error.code, "→", stats.error.hint);
else console.log(`${stats.data.nodes} nodes, ${stats.data.gpu_vram_gb}GB GPU, perf ${stats.data.perf_score}`);

const report = await doctor(ce);          // health checks + remediation
const t = await trace(ce, "<job-id>");    // where did this job stall?
```

`buildTools(ce)` returns the framework-agnostic catalog (name, description, JSON-schema, `run`) — the
same tools the MCP server exposes, callable directly.

## Design notes

- Runtime-agnostic (web-standard `fetch`); works in Node, Deno, Bun, browsers, edge Workers.
- `Result<T>` everywhere — never throws on an expected failure.
- The fault taxonomy maps node HTTP codes (402 → `INSUFFICIENT_CREDITS`, 403 → `CAPABILITY_DENIED` /
  `GUARDIAN_DENIED`, 503 → `DOCKER_UNAVAILABLE`, …) to actionable hints.
- New capabilities are added by appending one `ToolDef` — the MCP surface updates automatically.
