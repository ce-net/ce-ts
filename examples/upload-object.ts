/**
 * Upload an object of any size (auto-chunked to 1 MiB blobs + a manifest), then fetch
 * it back and verify byte-equality.
 * Run: `npx tsx examples/upload-object.ts`
 */
import { CeClient } from "../src/index.js";

async function main(): Promise<void> {
  const ce = CeClient.local();

  // A 3 MiB object — chunked into three 1 MiB blobs under the hood.
  const data = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

  const objectCid = await ce.data.putObject(data);
  console.log("object CID:", objectCid);

  const fetched = await ce.data.getObject(objectCid);
  const equal = fetched.length === data.length && fetched.every((b, i) => b === data[i]);
  console.log("round-trip equal:", equal);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
