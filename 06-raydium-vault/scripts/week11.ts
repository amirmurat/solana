import { Connection } from "@solana/web3.js";
import { preparePool, wallet, guard } from "./clmm";
async function main() {
  const c = new Connection(
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com",
    "confirmed",
  );
  await guard(c);
  console.log(await preparePool(c, wallet()));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
