/**
 * Directed deploy on a GPU host found in the atlas, then poll for completion.
 * Run: `npx tsx examples/bid-and-poll.ts`
 */
import { CeClient, Amount } from "../src/index.js";

async function main(): Promise<void> {
  const ce = CeClient.local(); // 127.0.0.1:8844, auto-discovers api.token (Node)

  const s = await ce.getStatus();
  console.log(`node ${s.nodeId} @ height ${s.height}, balance ${s.balance.toCredits()}`);

  const host = (await ce.atlas()).find((h) => h.tags.includes("gpu"));
  if (!host) {
    console.log("no GPU host found in the atlas");
    return;
  }

  const jobId = await ce.jobs.meshDeploy(host.nodeId, {
    image: "pytorch:latest",
    cmd: ["python", "train.py"],
    cpuCores: 4,
    memMb: 16384,
    durationSecs: 3600,
    bid: Amount.fromWholeCredits(100),
  });
  console.log(`deployed ${jobId} on ${host.nodeId}`);

  for (;;) {
    const job = await ce.jobs.get(jobId);
    if (job.status === "running" || job.status === "pending") {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    console.log("done:", job.status);
    break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
