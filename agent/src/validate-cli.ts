#!/usr/bin/env node
/**
 * `ce-validate` — run the CE app-validation harness against a node and print a pass/fail report.
 * Env: CE_NODE_URL, CE_HUB_URL, CE_TOKEN, CE_WASM_MODULE. Pass --live to run a real deploy→trace→kill.
 * Exits 0 if all steps pass, 1 if any fail, 2 on a crash — so CI can gate on it.
 */
import { CeClient } from "./client.js";
import { validate } from "./validate.js";

const client = new CeClient({
  nodeUrl: process.env.CE_NODE_URL,
  hubUrl: process.env.CE_HUB_URL,
  token: process.env.CE_TOKEN,
});

validate(client, { live: process.argv.includes("--live"), wasmModule: process.env.CE_WASM_MODULE })
  .then((r) => {
    for (const s of r.steps) console.log(`${s.ok ? "PASS" : "FAIL"}  ${s.name.padEnd(16)} ${s.detail}`);
    console.log(`\n${r.summary}`);
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => {
    console.error("validation crashed:", e);
    process.exit(2);
  });
