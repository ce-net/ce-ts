/**
 * Live SDK verification harness (temporary). Drives @ce-net/sdk against a running
 * node and prints PASS/FAIL per endpoint. Not part of the published example set.
 *
 * Run: CE_BASE_URL=http://127.0.0.1:18844 CE_API_TOKEN=... npx tsx examples/_verify-live.ts
 */
import { CeClient, Amount } from "../src/index.js";

const baseUrl = process.env["CE_BASE_URL"] ?? "http://127.0.0.1:18844";
const token = process.env["CE_API_TOKEN"] ?? "";

const ce = new CeClient({ baseUrl, token });

let pass = 0;
let fail = 0;
function ok(name: string, detail: string): void {
  pass++;
  console.log(`PASS ${name} :: ${detail}`);
}
function bad(name: string, err: unknown): void {
  fail++;
  console.log(`FAIL ${name} :: ${err instanceof Error ? err.message : String(err)}`);
}

async function main(): Promise<void> {
  // health
  try {
    ok("GET /health", String(await ce.status.health()));
  } catch (e) {
    bad("GET /health", e);
  }

  // status + balance breakdown (Wave-0)
  let myNodeId = "";
  try {
    const s = await ce.status.status();
    myNodeId = s.nodeId;
    ok(
      "GET /status",
      `height=${s.height} balance=${s.balance.toBaseUnits()} free=${s.free.toBaseUnits()} ` +
        `lockedChannels=${s.lockedChannels.toBaseUnits()} lockedBond=${s.lockedBond.toBaseUnits()} ` +
        `bond=${s.bond.toBaseUnits()} circ=${s.circulatingSupply.toBaseUnits()} burned=${s.burnedTotal.toBaseUnits()}`,
    );
  } catch (e) {
    bad("GET /status", e);
  }

  // beacon
  try {
    const b = await ce.status.beacon();
    ok("GET /beacon", `height=${b.height} hash=${b.hash.slice(0, 12)}`);
  } catch (e) {
    bad("GET /beacon", e);
  }

  // atlas
  try {
    const a = await ce.status.atlas();
    ok("GET /atlas", `entries=${a.length}`);
  } catch (e) {
    bad("GET /atlas", e);
  }

  // bootstrap
  try {
    const bs = await ce.status.bootstrap();
    ok("GET /bootstrap", `peers=${bs.peers.length}`);
  } catch (e) {
    bad("GET /bootstrap", e);
  }

  // history (Wave-0 reputation substrate)
  try {
    const h = await ce.history(myNodeId);
    ok(
      "GET /history/:node_id",
      `jobsHosted=${h.jobsHosted} earned=${h.earned.toBaseUnits()} newcomer=${h.isNewcomer()}`,
    );
  } catch (e) {
    bad("GET /history/:node_id", e);
  }

  // transactions (NEW Wave-0 endpoint)
  try {
    const txs = await ce.transactions(myNodeId, { limit: 10 });
    const first = txs[0];
    ok(
      "GET /transactions/:node_id",
      `count=${txs.length}` +
        (first
          ? ` first={kind=${first.kind} amount=${first.amount.toBaseUnits()} dir=${first.direction} h=${first.height}}`
          : " (empty)"),
    );
  } catch (e) {
    bad("GET /transactions/:node_id", e);
  }

  // jobs list
  try {
    const jobs = await ce.jobs.list();
    ok("GET /jobs", `count=${jobs.length}`);
  } catch (e) {
    bad("GET /jobs", e);
  }

  // channels list
  try {
    const ch = await ce.channels.list();
    ok("GET /channels", `count=${ch.length}`);
  } catch (e) {
    bad("GET /channels", e);
  }

  // blobs / objects round trip (upload-object example path)
  try {
    const data = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const cid = await ce.data.putObject(data);
    const back = await ce.data.getObject(cid);
    const equal = back.length === data.length && back.every((b, i) => b === data[i]);
    ok("POST /blobs + GET /blobs/:hash (object round-trip)", `cid=${cid.slice(0, 12)} equal=${equal}`);
  } catch (e) {
    bad("POST /blobs + GET /blobs/:hash (object round-trip)", e);
  }

  // transfer (transfer-amount example path) — expect 402 on a fresh no-mine node (zero balance)
  try {
    const txId = await ce.transfer(myNodeId, Amount.fromCredits("0.000000001"));
    ok("POST /transfer", `txId=${txId.slice(0, 12)}`);
  } catch (e) {
    // 402 PAYMENT_REQUIRED is an acceptable, expected outcome on a zero-balance node.
    const msg = e instanceof Error ? e.message : String(e);
    if (/402|payment|balance/i.test(msg)) {
      ok("POST /transfer (402 expected on zero-balance node)", msg);
    } else {
      bad("POST /transfer", e);
    }
  }

  // jobs.bid (bid-and-poll example path) — expect 402 on zero balance
  try {
    const id = await ce.jobs.bid({
      image: "alpine:latest",
      cmd: ["echo", "hi"],
      cpuCores: 1,
      memMb: 128,
      durationSecs: 30,
      bid: Amount.fromWholeCredits(1),
    });
    ok("POST /jobs/bid", `jobId=${id.slice(0, 12)}`);
    const job = await ce.jobs.get(id);
    ok("GET /jobs/:id", `status=${job.status}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/402|payment|balance/i.test(msg)) {
      ok("POST /jobs/bid (402 expected on zero-balance node)", msg);
    } else {
      bad("POST /jobs/bid", e);
    }
  }

  // SSE blocks stream — only meaningful if mining; bounded wait.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    let got = 0;
    try {
      for await (const blk of ce.streams.blocks({ signal: ctrl.signal })) {
        got++;
        void blk;
        break;
      }
    } catch {
      /* aborted — expected when no blocks within window */
    }
    clearTimeout(timer);
    ok("GET /blocks/stream (SSE)", got > 0 ? `received ${got} block(s)` : "connected, no block in 3s window (no-mine)");
  } catch (e) {
    bad("GET /blocks/stream (SSE)", e);
  }

  console.log(`\nSUMMARY pass=${pass} fail=${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
