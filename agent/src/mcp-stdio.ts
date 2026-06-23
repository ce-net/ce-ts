#!/usr/bin/env node
/**
 * Entrypoint: run the CE MCP server over stdio. Configured by environment so any agent host can
 * launch it:  CE_NODE_URL (default http://localhost:8844), CE_HUB_URL, CE_TOKEN.
 */
import { runStdio } from "./mcp.js";

runStdio({
  nodeUrl: process.env.CE_NODE_URL,
  hubUrl: process.env.CE_HUB_URL,
  token: process.env.CE_TOKEN,
}).catch((e) => {
  console.error("ce-agent-mcp failed to start:", e);
  process.exit(1);
});
