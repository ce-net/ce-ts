/**
 * Live block feed over SSE (works in Node, Deno, Bun, browsers, Workers).
 * Run: `npx tsx examples/stream-blocks.ts`  (Ctrl-C to stop)
 */
import { CeClient } from "../src/index.js";

async function main(): Promise<void> {
  const ce = CeClient.local();
  const ctrl = new AbortController();

  process.on("SIGINT", () => ctrl.abort());

  console.log("streaming blocks (Ctrl-C to stop)...");
  for await (const blk of ce.streams.blocks({ signal: ctrl.signal })) {
    console.log(`#${blk.index} ${blk.hash.slice(0, 12)}… txs=${blk.txCount} miner=${blk.miner.slice(0, 12)}…`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
