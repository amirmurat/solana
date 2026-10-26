import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import {
  getPdaPersonalPositionAddress,
  getPdaTickArrayAddress,
  getPdaExBitmapAccount,
  TickUtil,
  LiquidityMathUtil,
  PersonalPositionLayout,
} from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import { RaydiumVault } from "../target/types/raydium_vault";
import { addresses, checkNetwork } from "./vault";
import { CLMM, quoteSwap, sdk } from "../scripts/clmm";
export const MEMO = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);
const budget = () =>
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
export function secondary(vault: PublicKey, p: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("secondary"), vault.toBuffer()],
    p,
  )[0];
}
export async function strategyAccounts(
  p: Program<RaydiumVault>,
  provider: AnchorProvider,
  mint: PublicKey,
) {
  const a = addresses(p, mint, provider.wallet.publicKey);
  return {
    vaultState: a.vaultState,
    vaultTokenAccount: a.vaultTokenAccount,
    secondaryAccount: secondary(a.vaultState, p.programId),
    admin: provider.wallet.publicKey,
  };
}
export async function configure(
  p: Program<RaydiumVault>,
  provider: AnchorProvider,
  mint: PublicKey,
  mintB: PublicKey,
  pool: PublicKey,
) {
  await checkNetwork(provider);
  const a = await strategyAccounts(p, provider, mint);
  return p.methods
    .configurePool()
    .accountsStrict({
      vaultState: a.vaultState,
      secondaryMint: mintB,
      secondaryAccount: a.secondaryAccount,
      poolState: pool,
      admin: a.admin,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}
export async function control(
  p: Program<RaydiumVault>,
  provider: AnchorProvider,
  mint: PublicKey,
  start: boolean,
) {
  await checkNetwork(provider);
  const a = await strategyAccounts(p, provider, mint);
  return (start ? p.methods.startStrategy() : p.methods.settleStrategy())
    .accountsStrict(a)
    .rpc();
}
export async function vaultSwap(
  p: Program<RaydiumVault>,
  provider: AnchorProvider,
  payer: Keypair,
  mint: PublicKey,
  amount: BN,
  forward: boolean,
  forceBadMinimum = false,
) {
  await checkNetwork(provider);
  const a = await strategyAccounts(p, provider, mint),
    v = await p.account.vaultState.fetch(a.vaultState);
  const pool = await (
    await sdk(provider.connection, payer)
  ).clmm.getRpcClmmPoolInfo({ poolId: v.pool });
  const baseIs0 = mint.equals(pool.mintA),
    in0 = (forward && baseIs0) || (!forward && !baseIs0);
  const { data, quote, bitmap } = await quoteSwap(
    provider.connection,
    payer,
    v.pool,
    amount,
    in0,
  );
  const minOut = forceBadMinimum
    ? new BN("18446744073709551615")
    : quote.amountCalculated.muln(99).divn(100);
  const remaining = [
    bitmap,
    ...quote.accounts.filter((x) => !x.equals(bitmap)),
  ].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
  const method = p.methods
    .swapTokens(amount, minOut, new BN(0), forward)
    .accountsStrict({
      ...a,
      poolState: v.pool,
      ammConfig: data.rpcData.configId,
      inputVault: in0 ? data.rpcData.vaultA : data.rpcData.vaultB,
      outputVault: in0 ? data.rpcData.vaultB : data.rpcData.vaultA,
      observationState: data.rpcData.observationId,
      inputVaultMint: forward ? mint : v.secondaryMint,
      outputVaultMint: forward ? v.secondaryMint : mint,
      clmmProgram: CLMM,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      memoProgram: MEMO,
    })
    .remainingAccounts(remaining)
    .preInstructions([budget()]);
  if (!forceBadMinimum)
    return {
      signature: await method.rpc(),
      expected: quote.amountCalculated.toString(),
      minimum: minOut.toString(),
    };
  // An on-chain failed transaction is required for an Explorer-verifiable slippage example.
  const tx = await method.transaction();
  const hash = await provider.connection.getLatestBlockhash("confirmed");
  tx.feePayer = provider.wallet.publicKey;
  tx.recentBlockhash = hash.blockhash;
  const signed = await provider.wallet.signTransaction(tx);
  const signature = await provider.connection.sendRawTransaction(
    signed.serialize(),
    { skipPreflight: true },
  );
  const result = await provider.connection.confirmTransaction(
    { ...hash, signature },
    "confirmed",
  );
  if (!result.value.err)
    throw Error("Impossible slippage minimum unexpectedly succeeded");
  return {
    signature,
    expected: quote.amountCalculated.toString(),
    minimum: minOut.toString(),
    error: result.value.err,
  };
}
export type Position = {
  nft: PublicKey;
  account: PublicKey;
  personal: PublicKey;
  lower: number;
  upper: number;
  arrayLower: PublicKey;
  arrayUpper: PublicKey;
};
export async function openPosition(
  p: Program<RaydiumVault>,
  provider: AnchorProvider,
  payer: Keypair,
  mint: PublicKey,
  width = "0.02",
) {
  await checkNetwork(provider);
  const a = await strategyAccounts(p, provider, mint),
    v = await p.account.vaultState.fetch(a.vaultState),
    ray = await sdk(provider.connection, payer),
    data = await ray.clmm.getPoolInfoFromRpc(v.pool.toBase58());
  const price = new Decimal(data.rpcPoolInfo.currentPrice),
    spacing = data.rpcPoolInfo.tickSpacing;
  const lower = TickUtil.toTickIndex(
      TickUtil.priceToTick(price.mul(new Decimal(1).sub(width)), 6, 6),
      spacing,
    ),
    upper = TickUtil.toTickIndex(
      TickUtil.priceToTick(price.mul(new Decimal(1).add(width)), 6, 6),
      spacing,
    );
  const baseBalance = (
      await getAccount(provider.connection, a.vaultTokenAccount)
    ).amount,
    secondBalance = (await getAccount(provider.connection, a.secondaryAccount))
      .amount,
    baseIs0 = mint.equals(data.rpcPoolInfo.mintA);
  const maxA = new BN((baseIs0 ? baseBalance : secondBalance).toString())
      .muln(90)
      .divn(100),
    maxB = new BN((baseIs0 ? secondBalance : baseBalance).toString())
      .muln(90)
      .divn(100);
  const lo = TickUtil.getSqrtPriceAtTick(lower),
    hi = TickUtil.getSqrtPriceAtTick(upper),
    liquidity = LiquidityMathUtil.getLiquidityFromAmounts(
      data.rpcPoolInfo.sqrtPriceX64,
      lo,
      hi,
      maxA,
      maxB,
    );
  if (liquidity.isZero()) throw Error("No balanced liquidity available");
  const needed = LiquidityMathUtil.getAmountsForLiquidity(
    data.rpcPoolInfo.sqrtPriceX64,
    lo,
    hi,
    liquidity,
    true,
  );
  const capA = needed.amountA.muln(101).divn(100).addn(1),
    capB = needed.amountB.muln(101).divn(100).addn(1);
  if (
    capA.gt(new BN((baseIs0 ? baseBalance : secondBalance).toString())) ||
    capB.gt(new BN((baseIs0 ? secondBalance : baseBalance).toString()))
  )
    throw Error("Liquidity quote exceeds account balance");
  const nft = Keypair.generate(),
    personal = getPdaPersonalPositionAddress(CLMM, nft.publicKey).publicKey,
    account = getAssociatedTokenAddressSync(
      nft.publicKey,
      a.vaultState,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
  const startLower = Math.floor(lower / (spacing * 60)) * (spacing * 60),
    startUpper = Math.floor(upper / (spacing * 60)) * (spacing * 60),
    arrayLower = getPdaTickArrayAddress(CLMM, v.pool, startLower).publicKey,
    arrayUpper = getPdaTickArrayAddress(CLMM, v.pool, startUpper).publicKey;
  const bitmap = getPdaExBitmapAccount(CLMM, v.pool).publicKey;
  const signature = await p.methods
    .openClmmPosition(
      lower,
      upper,
      startLower,
      startUpper,
      liquidity,
      capA,
      capB,
    )
    .accountsStrict({
      ...a,
      poolState: v.pool,
      positionNftMint: nft.publicKey,
      positionNftAccount: account,
      personalPosition: personal,
      tickArrayLower: arrayLower,
      tickArrayUpper: arrayUpper,
      tokenVault0: data.rpcPoolInfo.vaultA,
      tokenVault1: data.rpcPoolInfo.vaultB,
      vault0Mint: data.rpcPoolInfo.mintA,
      vault1Mint: data.rpcPoolInfo.mintB,
      clmmProgram: CLMM,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .remainingAccounts([{ pubkey: bitmap, isSigner: false, isWritable: true }])
    .signers([nft])
    .preInstructions([budget()])
    .rpc();
  return {
    signature,
    position: {
      nft: nft.publicKey,
      account,
      personal,
      lower,
      upper,
      arrayLower,
      arrayUpper,
    },
    price: price.toString(),
    lowerPrice: TickUtil.tickToPrice(lower, 6, 6).toString(),
    upperPrice: TickUtil.tickToPrice(upper, 6, 6).toString(),
    maxA: capA.toString(),
    maxB: capB.toString(),
  };
}
export async function managePosition(
  p: Program<RaydiumVault>,
  provider: AnchorProvider,
  payer: Keypair,
  mint: PublicKey,
  position: Position,
  close: boolean,
) {
  await checkNetwork(provider);
  const a = await strategyAccounts(p, provider, mint),
    v = await p.account.vaultState.fetch(a.vaultState),
    data = await (
      await sdk(provider.connection, payer)
    ).clmm.getRpcClmmPoolInfo({ poolId: v.pool });
  const personalInfo = await provider.connection.getAccountInfo(
    position.personal,
  );
  if (!personalInfo) throw Error("Position missing");
  const personal = PersonalPositionLayout.decode(personalInfo.data);
  const expected = LiquidityMathUtil.getAmountsForLiquidity(
    data.sqrtPriceX64,
    TickUtil.getSqrtPriceAtTick(position.lower),
    TickUtil.getSqrtPriceAtTick(position.upper),
    personal.liquidity,
    false,
  );
  const minimumA = expected.amountA.muln(99).divn(100),
    minimumB = expected.amountB.muln(99).divn(100),
    bitmap = getPdaExBitmapAccount(CLMM, v.pool).publicKey;
  return (
    close
      ? p.methods.closeClmmPosition(minimumA, minimumB)
      : p.methods.collectClmmFees()
  )
    .accountsStrict({
      ...a,
      poolState: v.pool,
      positionNftMint: position.nft,
      positionNftAccount: position.account,
      personalPosition: position.personal,
      tickArrayLower: position.arrayLower,
      tickArrayUpper: position.arrayUpper,
      tokenVault0: data.vaultA,
      tokenVault1: data.vaultB,
      vault0Mint: data.mintA,
      vault1Mint: data.mintB,
      clmmProgram: CLMM,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      memoProgram: MEMO,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([{ pubkey: bitmap, isSigner: false, isWritable: true }])
    .preInstructions([budget()])
    .rpc();
}
