/**
 * MCP adapter — exposes the CE tool catalog as a Model Context Protocol server so any agent host
 * (Claude Code, Claude Desktop, etc.) can drive CE directly. Uses the low-level Server API and
 * passes JSON Schema straight through, so it stays aligned with the framework-agnostic ToolDefs.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CeClient, type CeClientOptions } from "./client.js";
import { buildTools, type ToolDef } from "./tools.js";

export function createCeMcpServer(opts: CeClientOptions = {}) {
  const client = new CeClient(opts);
  const tools = buildTools(client);
  const byName = new Map<string, ToolDef>(tools.map((t) => [t.name, t]));

  const server = new Server({ name: "ce-agent", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: "text" as const, text: `unknown tool: ${req.params.name}` }] };
    }
    try {
      const result = await tool.run((req.params.arguments ?? {}) as Record<string, unknown>);
      // Surface a structured fault as an MCP error so the agent treats it as a failure, with the
      // fix-it hint right there in the payload.
      const isError = !!(result && typeof result === "object" && (result as { ok?: boolean }).ok === false);
      return { isError, content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `tool threw: ${e instanceof Error ? e.message : String(e)}` }],
      };
    }
  });

  return { server, client, tools };
}

/** Run the server over stdio — the transport agent hosts launch as a subprocess. */
export async function runStdio(opts: CeClientOptions = {}): Promise<void> {
  const { server } = createCeMcpServer(opts);
  await server.connect(new StdioServerTransport());
}
