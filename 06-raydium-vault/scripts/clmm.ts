import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Raydium,
  DEVNET_PROGRAM_ID,
  ClmmConfigLayout,
  getPdaAmmConfigId,
  TxVersion,
  TickUtil,
  LiquidityMathUtil,
  swapInternal,
  getPdaExBitmapAccount,
  TickArrayBitmapExtensionLayout,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import Decimal from "decimal.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
export const CLMM = DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID;
export const CONFIG = getPdaAmmConfigId(CLMM, 0).publicKey;
export async function guard(connection: Connection) {
  const u = new URL(connection.rpcEndpoint);
  const local =
    ["localhost", "127.0.0.1"].includes(u.hostname) && u.port === "8899";
  const dev = u.protocol === "https:" && u.hostname === "api.devnet.solana.com";
  if (!local && !dev)
    throw Error("Only localnet:8899 and official Devnet allowed");
  if (
    dev &&
    (await connection.getGenesisHash()) !==
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  )
    throw Error("Wrong Devnet genesis");
  return local ? "localnet" : "devnet";
}
export function wallet() {
  if (!process.env.ANCHOR_WALLET)
    throw Error("Set ANCHOR_WALLET to a private local keypair file");
  return Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(process.env.ANCHOR_WALLET, "utf8")),
    ),
  );
}
export async function sdk(connection: Connection, owner: Keypair) {
  await guard(connection);
  return Raydium.load({
    connection,
    owner,
    cluster: "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
  });
}
export type CoursePool = {
  cluster: string;
  pool: string;
  mintA: string;
  mintB: string;
  manualNft: string;
  manualLower: number;
  manualUpper: number;
  initialPrice: string;
  lowerPrice: string;
  upperPrice: string;
  signatures: string[];
};
const token = (key: PublicKey, symbol: string) => ({
  chainId: 101,
  address: key.toBase58(),
  programId: TOKEN_PROGRAM_ID.toBase58(),
  logoURI: "",
  symbol,
  name: symbol,
  decimals: 6,
  tags: [],
  extensions: {},
});
export async function preparePool(
  connection: Connection,
  payer: Keypair,
): Promise<CoursePool> {
  const cluster = await guard(connection),
    file = `evidence/week11-${cluster}.json`;
  if (process.env.COURSE_FRESH_POOL !== "1" && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as CoursePool;
    if (await connection.getAccountInfo(new PublicKey(saved.pool)))
      return saved;
  }
  const ray = await sdk(connection, payer),
    mints = [] as PublicKey[];
  for (let i = 0; i < 2; i++) {
    const m = await createMint(connection, payer, payer.publicKey, null, 6);
    mints.push(m);
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      m,
      payer.publicKey,
    );
    await mintTo(connection, payer, m, ata.address, payer, 10_000_000_000_000n);
  }
  const info = await connection.getAccountInfo(CONFIG);
  if (!info?.owner.equals(CLMM))
    throw Error(
      "Clone/load the official Devnet AMM config before running localnet",
    );
  const conf = ClmmConfigLayout.decode(info.data);
  const made = await ray.clmm.createPool({
    programId: CLMM,
    mint1: token(mints[0], "AMIR-A"),
    mint2: token(mints[1], "AMIR-B"),
    ammConfig: {
      ...conf,
      id: CONFIG,
      fundOwner: conf.fundOwner.toBase58(),
      description: "Course test pool",
    },
    initialPrice: new Decimal(1),
    txVersion: TxVersion.LEGACY,
    computeBudgetConfig: { units: 1_200_000, microLamports: 0 },
  });
  const { txId } = await made.execute({ sendAndConfirm: true });
  const pool = new PublicKey(made.extInfo.address.id);
  // A new empty pool has no tick cache yet. Use the SDK's creation result for the first position.
  const data = {
    poolInfo: made.extInfo.mockPoolInfo,
    poolKeys: made.extInfo.address,
    rpcPoolInfo: {
      sqrtPriceX64: TickUtil.priceToSqrtPriceX64(new Decimal(1), 6, 6),
    },
  };
  const lower = TickUtil.toTickIndex(
      TickUtil.priceToTick(new Decimal("0.9"), 6, 6),
      conf.tickSpacing,
    ),
    upper = TickUtil.toTickIndex(
      TickUtil.priceToTick(new Decimal("1.1"), 6, 6),
      conf.tickSpacing,
    );
  const liq = LiquidityMathUtil.getLiquidityAndAmountsFromAmount({
    sqrtPriceCurrentX64: data.rpcPoolInfo.sqrtPriceX64,
    sqrtPriceLowerX64: TickUtil.getSqrtPriceAtTick(lower),
    sqrtPriceUpperX64: TickUtil.getSqrtPriceAtTick(upper),
    amountInfo: { type: "amountA", amount: new BN("100000000000") },
  });
  // SDK 0.2.70's convenience result quotes amounts against the input rather than the derived L.
  const actual = LiquidityMathUtil.getAmountsForLiquidity(
    data.rpcPoolInfo.sqrtPriceX64,
    TickUtil.getSqrtPriceAtTick(lower),
    TickUtil.getSqrtPriceAtTick(upper),
    liq.liquidity,
    true,
  );
  const opened = await ray.clmm.openPositionFromLiquidity({
    poolInfo: data.poolInfo,
    poolKeys: data.poolKeys,
    ownerInfo: { useSOLBalance: false },
    amountMaxA: actual.amountA.muln(101).divn(100),
    amountMaxB: actual.amountB.muln(101).divn(100),
    tickLower: lower,
    tickUpper: upper,
    liquidity: liq.liquidity,
    nft2022: true,
    withMetadata: "no-create",
    txVersion: TxVersion.LEGACY,
    computeBudgetConfig: { units: 1_200_000, microLamports: 0 },
  });
  const pos = await opened.execute({ sendAndConfirm: true });
  const state: CoursePool = {
    cluster,
    pool: pool.toBase58(),
    mintA: data.poolInfo.mintA.address,
    mintB: data.poolInfo.mintB.address,
    manualNft: opened.extInfo.address.nftMint.toBase58(),
    manualLower: lower,
    manualUpper: upper,
    initialPrice: "1",
    lowerPrice: TickUtil.tickToPrice(lower, 6, 6).toString(),
    upperPrice: TickUtil.tickToPrice(upper, 6, 6).toString(),
    signatures: [txId, pos.txId],
  };
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
  return state;
}
export async function quoteSwap(
  connection: Connection,
  owner: Keypair,
  pool: PublicKey,
  amount: BN,
  zeroForOne: boolean,
) {
  const ray = await sdk(connection, owner);
  const data = await ray.clmm.getSwapPoolInfo(pool, zeroForOne);
  const bitmap = getPdaExBitmapAccount(CLMM, pool).publicKey;
  const bitmapInfo = await connection.getAccountInfo(bitmap);
  if (!bitmapInfo) throw Error("Pool bitmap missing");
  const quote = swapInternal({
    programId: CLMM,
    poolId: pool,
    poolInfo: data.rpcData,
    tickArrays: data.tickArrays,
    configInfo: data.configInfo,
    tickarrayBitmapExtension: TickArrayBitmapExtensionLayout.decode(
      bitmapInfo.data,
    ),
    amountSpecified: amount,
    sqrtPriceLimitX64: new BN(0),
    zeroForOne,
    isBaseInput: true,
    blockTimestamp: Math.floor(Date.now() / 1000),
    includeExtraTickArrays: true,
  });
  if (quote.amountCalculated.isZero()) throw Error("Zero output quote");
  return { ray, data, quote, bitmap };
}
export async function walletSwap(
  connection: Connection,
  owner: Keypair,
  pool: PublicKey,
  amount: BN,
  zeroForOne: boolean,
) {
  const { ray, data, quote } = await quoteSwap(
    connection,
    owner,
    pool,
    amount,
    zeroForOne,
  );
  // Own/local pools are absent from the hosted API: obtain all keys directly from RPC.
  const full = await ray.clmm.getPoolInfoFromRpc(pool.toBase58());
  const made = await ray.clmm.swap({
    poolInfo: data.poolInfo,
    poolKeys: full.poolKeys,
    inputMint: zeroForOne
      ? data.poolInfo.mintA.address
      : data.poolInfo.mintB.address,
    amountIn: amount,
    amountOutMin: quote.amountCalculated.muln(99).divn(100),
    observationId: data.rpcData.observationId,
    ownerInfo: { useSOLBalance: false },
    remainingAccounts: quote.accounts,
    txVersion: TxVersion.LEGACY,
    computeBudgetConfig: { units: 1_200_000, microLamports: 0 },
  });
  return (await made.execute({ sendAndConfirm: true })).txId;
}
