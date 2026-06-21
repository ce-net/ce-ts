/**
 * Mesh request/reply — the canonical device-to-device app channel.
 * One side serves a topic; the other side requests over the mesh.
 * Run (server): `npx tsx examples/mesh-request-reply.ts serve`
 * Run (client): `npx tsx examples/mesh-request-reply.ts request <peer-node-id-hex>`
 */
import { CeClient, utf8ToBytes, bytesToUtf8 } from "../src/index.js";

const TOPIC = "examples/echo";

async function serve(ce: CeClient): Promise<void> {
  await ce.mesh.subscribe(TOPIC);
  console.log(`serving '${TOPIC}'; waiting for requests...`);
  for await (const msg of ce.mesh.streamMessages()) {
    if (msg.topic !== TOPIC || msg.replyToken === null) continue;
    const req = bytesToUtf8(msg.payload());
    console.log(`request from ${msg.from.slice(0, 12)}…: ${req}`);
    await ce.mesh.reply(msg.replyToken, utf8ToBytes(`echo: ${req}`));
  }
}

async function request(ce: CeClient, peer: string): Promise<void> {
  const reply = await ce.mesh.request(peer, TOPIC, utf8ToBytes("hello mesh"), 10_000);
  console.log("reply:", bytesToUtf8(reply));
}

async function main(): Promise<void> {
  const ce = CeClient.local();
  const mode = process.argv[2];
  if (mode === "serve") {
    await serve(ce);
  } else if (mode === "request" && process.argv[3]) {
    await request(ce, process.argv[3]);
  } else {
    console.error("usage: mesh-request-reply.ts serve | request <peer-node-id-hex>");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
