/**
 * Week 11: own test tokens + own Raydium CLMM pool.
 *
 *   1. Create two SPL tokens (6 decimals) and mint 1 000 000 of each to the wallet
 *   2. Create a Raydium CLMM pool TOKEN_A / TOKEN_B, initial price 1
 *      (AMM config index 0: tick spacing 60, trade fee 0.25%)
 *   3. Save the addresses to pool-<cluster>.json (used in weeks 12-13)
 *
 * Run (Devnet):
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json npm run create-pool
 *
 * Only localnet:8899 (validator with the Devnet Raydium binary, see scripts/test-local.sh)
 * and the official Devnet are accepted. The AMM config is read from the chain, not from the
 * hosted API, so the same script runs in CI.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Raydium,
  DEVNET_PROGRAM_ID,
  DEV_API_URLS,
  TxVersion,
  ClmmConfigLayout,
  getPdaAmmConfigId,
} from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const CLMM_PROGRAM_ID = DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID;
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DECIMALS = 6;
const MINT_AMOUNT = 1_000_000n; // whole tokens of each mint
const INITIAL_PRICE = 1; // 1 TOKEN_A = 1 TOKEN_B
const CONFIG_INDEX = 0; // tick spacing 60, fee 0.25%

export async function checkCluster(connection: Connection): Promise<"localnet" | "devnet"> {
  const u = new URL(connection.rpcEndpoint);
  const local = ["127.0.0.1", "localhost"].includes(u.hostname) && u.port === "8899";
  const dev = u.protocol === "https:" && u.hostname === "api.devnet.solana.com";
  if (!local && !dev) throw new Error("Only localnet:8899 and the official Devnet RPC are allowed");
  if (dev && (await connection.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("Not Devnet");
  return local ? "localnet" : "devnet";
}

/** Raydium AMM config read from the chain (exists on Devnet; CI clones it into localnet). */
export async function loadAmmConfig(connection: Connection, index = CONFIG_INDEX) {
  const id = getPdaAmmConfigId(CLMM_PROGRAM_ID, index).publicKey;
  const info = await connection.getAccountInfo(id);
  if (!info || !info.owner.equals(CLMM_PROGRAM_ID)) {
    throw new Error(`Raydium AMM config ${id.toBase58()} not found: load it into the validator (scripts/test-local.sh)`);
  }
  const conf = ClmmConfigLayout.decode(info.data);
  // createPool only needs these fields (fund fee/owner are used for the SDK's mock pool info only)
  return {
    id,
    index: conf.index,
    protocolFeeRate: conf.protocolFeeRate,
    tradeFeeRate: conf.tradeFeeRate,
    tickSpacing: conf.tickSpacing,
    fundFeeRate: 0,
    fundOwner: "",
    description: "",
  };
}

export async function loadRaydium(connection: Connection, owner: Keypair) {
  return Raydium.load({
    owner,
    connection,
    cluster: "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
    urlConfigs: DEV_API_URLS,
  });
}

export const splToken = (mint: PublicKey) =>
  ({ address: mint.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals: DECIMALS }) as any;

/** Create a CLMM pool for two existing mints at price 1. Returns the pool id and signature. */
export async function createPool(raydium: Raydium, ammConfig: Awaited<ReturnType<typeof loadAmmConfig>>, mint1: PublicKey, mint2: PublicKey) {
  const created = await raydium.clmm.createPool({
    programId: CLMM_PROGRAM_ID,
    mint1: splToken(mint1),
    mint2: splToken(mint2),
    ammConfig: ammConfig as any,
    initialPrice: new Decimal(INITIAL_PRICE),
    txVersion: TxVersion.LEGACY,
  });
  const { txId } = await created.execute({ sendAndConfirm: true });
  return { poolId: new PublicKey(String((created.extInfo as any).address.id)), txId };
}

function loadWallet(): Keypair {
  const keyPath = process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8"))));
}

async function main() {
  const connection = new Connection(process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com", "confirmed");
  const cluster = await checkCluster(connection);
  const owner = loadWallet();
  console.log("Cluster:", cluster);
  console.log("Wallet :", owner.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(owner.publicKey)) / 1e9, "SOL");

  console.log("\n[1/3] Creating test tokens...");
  const mintA = await createMint(connection, owner, owner.publicKey, null, DECIMALS);
  const mintB = await createMint(connection, owner, owner.publicKey, null, DECIMALS);
  for (const [name, mint] of [["TOKEN_A", mintA], ["TOKEN_B", mintB]] as const) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, owner, mint, owner.publicKey);
    await mintTo(connection, owner, mint, ata.address, owner, MINT_AMOUNT * 10n ** BigInt(DECIMALS));
    console.log(`  ${name}: ${mint.toBase58()} (minted ${MINT_AMOUNT})`);
  }

  console.log("\n[2/3] Creating Raydium CLMM pool...");
  const ammConfig = await loadAmmConfig(connection);
  console.log(`  Config: ${ammConfig.id.toBase58()} (tickSpacing=${ammConfig.tickSpacing}, fee=${ammConfig.tradeFeeRate / 10000}%)`);
  const raydium = await loadRaydium(connection, owner);
  const { poolId, txId } = await createPool(raydium, ammConfig, mintA, mintB);
  const poolAccount = await connection.getAccountInfo(poolId, "confirmed");
  if (!poolAccount?.owner.equals(CLMM_PROGRAM_ID)) throw new Error("Pool account is not owned by Raydium CLMM");
  const explorer = (kind: string, id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
  console.log("  Pool :", poolId.toBase58());
  console.log("  Owner:", poolAccount.owner.toBase58());
  if (cluster === "devnet") console.log("  Tx   :", explorer("tx", txId));

  const out = path.join(__dirname, "..", `pool-${cluster}.json`);
  console.log("\n[3/3] Saving", out);
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        cluster,
        clmmProgram: CLMM_PROGRAM_ID.toBase58(),
        tokenA: mintA.toBase58(),
        tokenB: mintB.toBase58(),
        poolId: poolId.toBase58(),
        ammConfig: ammConfig.id.toBase58(),
        tickSpacing: ammConfig.tickSpacing,
        tx: txId,
        explorer: cluster === "devnet" ? explorer("address", poolId.toBase58()) : null,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Done.");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
