/**
 * Transfer 1.5 credits — money is always an Amount, never a JS number.
 * Run: `npx tsx examples/transfer-amount.ts <recipient-node-id-hex>`
 */
import { CeClient, Amount } from "../src/index.js";

async function main(): Promise<void> {
  const recipient = process.argv[2];
  if (!recipient) {
    console.error("usage: transfer-amount.ts <recipient-node-id-hex>");
    process.exitCode = 1;
    return;
  }

  const ce = CeClient.local();

  const amount = Amount.fromCredits("1.5");
  console.log(`transferring ${amount.toString()} (${amount.toBaseUnits()} base units)`);

  const txId = await ce.transfer(recipient, amount);
  console.log("tx:", txId);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
