/**
 * Weeks 12–13: vault + real Raydium CLMM program (localnet with the Devnet binary, or Devnet).
 *
 * Setup (every run creates its own tokens and pools):
 *   - admin creates TOKEN_A / TOKEN_B / TOKEN_C and CLMM pools A/B (price 1) and A/C (empty, for WrongPool)
 *   - admin adds wallet liquidity to A/B (otherwise there is nothing to swap against)
 *   - vault for TOKEN_A, a user deposits 1000 TOKEN_A (1% fee → 990 tracked, 990 shares)
 *
 * Week 12: add_pair_token, swap 300 A → B, 50% limit, deposit/withdraw pause, rejections
 * Final: swap all B → A + sync_vault in one transaction (even if someone sent B), user withdraws everything
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAccount,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
  transfer,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  AccountMeta,
} from "@solana/web3.js";
import { Raydium, TxVersion, PoolUtils, TickUtils, getPdaExBitmapAccount } from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import { assert } from "chai";
import { ClmmVault } from "../target/types/clmm_vault";
import { initialize, createCard } from "../client/vault";
import { CLMM_PROGRAM_ID as CLMM, loadAmmConfig, loadRaydium, createPool } from "../scripts/create-clmm-pool";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const UNIT = 1_000_000; // decimals = 6
const U64_MAX = new BN("18446744073709551615"); // swap: "whole balance"

/** Accounts of one vault needed by the Raydium instructions */
interface VaultCtx {
  state: PublicKey;
  accA: PublicKey; // vault token (token_mint)
  accB: PublicKey; // second pair token
  mintA: PublicKey;
  mintB: PublicKey;
}

describe("clmm_vault + Raydium CLMM (weeks 12–13)", () => {
  // "confirmed": the next transaction must see accounts created by the previous one
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(new Connection(env.connection.rpcEndpoint, "confirmed"), env.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const connection = provider.connection;
  const program = new Program<ClmmVault>((anchor.workspace.ClmmVault as Program<ClmmVault>).idl, provider);
  const admin = (provider.wallet as anchor.Wallet).payer;
  const user = Keypair.generate();

  let raydium: Raydium;
  let tokenA: PublicKey;
  let tokenB: PublicKey;
  let tokenC: PublicKey;
  let poolId: PublicKey; // A / B with liquidity
  let otherPoolId: PublicKey; // A / C, empty — only for WrongPool
  let walletPersonalPosition: PublicKey; // admin wallet position in the same pool (foreign to the vault)

  let vault: VaultCtx; // main vault on TOKEN_A
  let shareMint: PublicKey;
  let feeWallet: PublicKey;
  let userCard: PublicKey;
  let userTokenA: PublicKey;
  let userShares: PublicKey;
  let deposited: bigint; // TOKEN_A tracked by the vault after the 1% deposit fee

  // ─── helpers ───────────────────────────────────────────────────────────────

  const balance = async (acc: PublicKey) => (await getAccount(connection, acc)).amount;
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });
  const exBitmap = () => getPdaExBitmapAccount(CLMM, poolId).publicKey;
  const writable = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  const fetchVault = (state: PublicKey) => program.account.vaultState.fetch(state);
  const signers = (signer: Keypair) => (signer === admin ? [] : [signer]);

  // Expect a specific failure (by error name or by text in the logs)
  const expectError = async (fn: () => Promise<unknown>, code: string) => {
    try {
      await fn();
    } catch (e: any) {
      const text = `${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""} ${(e?.logs ?? []).join(" ")}`;
      assert.include(text, code, `expected ${code}, got: ${text.slice(0, 300)}`);
      return;
    }
    assert.fail(`expected ${code}, but the call succeeded`);
  };

  const poolInfo = () => raydium.clmm.getPoolInfoFromRpc(poolId.toBase58());

  // Fresh swap quote: expected output and the tick arrays on the path
  const quote = async (inputMint: PublicKey, amountIn: BN) => {
    const { poolInfo: info, poolKeys, computePoolInfo, tickData } = await poolInfo();
    const out = info.mintA.address === inputMint.toBase58() ? info.mintB : info.mintA;
    const res = PoolUtils.computeAmountOutFormat({
      poolInfo: computePoolInfo,
      tickArrayCache: tickData[poolId.toBase58()],
      amountIn,
      tokenOut: out,
      slippage: 0.05,
      epochInfo: await raydium.fetchEpochInfo(),
    } as any);
    return { info, poolKeys, computePoolInfo, res };
  };

  /** Builder for vault::swap. `quoteAmount` — what actually goes into the swap (for tick arrays) when amountIn = U64_MAX. */
  const vaultSwap = async (
    v: VaultCtx,
    amountIn: BN,
    minOut: BN,
    aToB: boolean,
    opts: { signer?: Keypair; pool?: PublicKey; swapPoolVaults?: boolean; quoteAmount?: BN } = {},
  ) => {
    const signer = opts.signer ?? admin;
    const input = aToB ? v.mintA : v.mintB;
    const output = aToB ? v.mintB : v.mintA;
    const { info, poolKeys, computePoolInfo, res } = await quote(input, opts.quoteAmount ?? amountIn);
    const poolVault = (mint: PublicKey) =>
      new PublicKey(info.mintA.address === mint.toBase58() ? poolKeys.vault.A : poolKeys.vault.B);
    let [inputVault, outputVault] = [poolVault(input), poolVault(output)];
    if (opts.swapPoolVaults) [inputVault, outputVault] = [outputVault, inputVault];

    return program.methods
      .swap(amountIn, minOut, aToB)
      .accounts({
        admin: signer.publicKey,
        vaultState: v.state,
        vaultTokenAccount: v.accA,
        vaultTokenAccountB: v.accB,
        ammConfig: new PublicKey(poolKeys.config.id),
        poolState: opts.pool ?? poolId,
        inputVault,
        outputVault,
        observationState: computePoolInfo.observationId,
        inputVaultMint: input,
        outputVaultMint: output,
        clmmProgram: CLMM,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        memoProgram: MEMO_PROGRAM_ID,
      } as any)
      .remainingAccounts([writable(exBitmap()), ...res.remainingAccounts.map(writable)])
      .preInstructions([cu])
      .signers(signers(signer));
  };

  const syncVault = (v: VaultCtx, signer: Keypair = admin) =>
    program.methods
      .syncVault()
      .accounts({ admin: signer.publicKey, vaultState: v.state, vaultTokenAccount: v.accA, vaultTokenAccountB: v.accB } as any)
      .signers(signers(signer));

  // Wallet (not vault) swaps — trading in the pool so that positions earn fees
  const walletSwap = async (inputMint: PublicKey, amountIn: BN) => {
    const { info, poolKeys, computePoolInfo, res } = await quote(inputMint, amountIn);
    const { execute } = await raydium.clmm.swap({
      poolInfo: info,
      poolKeys,
      inputMint,
      amountIn,
      amountOutMin: res.minAmountOut.amount.raw,
      observationId: computePoolInfo.observationId,
      ownerInfo: { useSOLBalance: false },
      remainingAccounts: res.remainingAccounts,
      txVersion: TxVersion.V0,
    } as any);
    await execute({ sendAndConfirm: true });
  };

  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const vaultPdas = (mintA: PublicKey, mintB: PublicKey): VaultCtx => ({
    state: pda(Buffer.from("vault"), mintA.toBuffer()),
    accA: pda(Buffer.from("vault_tokens"), mintA.toBuffer()),
    accB: pda(Buffer.from("vault_tokens_b"), mintA.toBuffer()),
    mintA,
    mintB,
  });

  const addPairToken = (v: VaultCtx, signer: Keypair = admin) =>
    program.methods
      .addPairToken()
      .accounts({ vaultState: v.state, tokenMintB: v.mintB, vaultTokenAccountB: v.accB, admin: signer.publicKey } as any)
      .signers(signers(signer))
      .rpc();

  const userDeposit = (amount: number | bigint) =>
    program.methods
      .deposit(new BN(amount.toString()))
      .accountsStrict({
        vaultState: vault.state,
        userCard,
        vaultTokenAccount: vault.accA,
        shareMint,
        userTokenAccount: userTokenA,
        userShareAccount: userShares,
        feeWallet,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

  const userWithdraw = (shares: number | bigint) =>
    program.methods
      .withdraw(new BN(shares.toString()), new BN(0))
      .accountsStrict({
        vaultState: vault.state,
        userCard,
        vaultTokenAccount: vault.accA,
        shareMint,
        userTokenAccount: userTokenA,
        userShareAccount: userShares,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

  const adminAta = (mint: PublicKey) => getAssociatedTokenAddressSync(mint, admin.publicKey);

  // ─── setup ─────────────────────────────────────────────────────────────────

  before(async () => {
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
      ),
      [admin],
    );

    // 1. Own tokens
    tokenA = await createMint(connection, admin, admin.publicKey, null, 6);
    tokenB = await createMint(connection, admin, admin.publicKey, null, 6);
    tokenC = await createMint(connection, admin, admin.publicKey, null, 6);
    for (const mint of [tokenA, tokenB]) {
      const ata = await getOrCreateAssociatedTokenAccount(connection, admin, mint, admin.publicKey);
      await mintTo(connection, admin, mint, ata.address, admin, 1_000_000 * UNIT);
    }

    // 2. CLMM pools at price 1 (week 11 script helpers): A / B (working) and A / C (empty)
    raydium = await loadRaydium(connection, admin);
    const ammConfig = await loadAmmConfig(connection);
    poolId = (await createPool(raydium, ammConfig, tokenA, tokenB)).poolId;
    otherPoolId = (await createPool(raydium, ammConfig, tokenA, tokenC)).poolId;
    console.log("  Pool A/B:", poolId.toBase58());

    // 3. Wallet liquidity: 10 000 of each token in the price range 0.5–2
    const { poolInfo: info, poolKeys } = await poolInfo();
    const tickAt = (price: number) => TickUtils.getPriceAndTick({ poolInfo: info, price: new Decimal(price), baseIn: true }).tick;
    const lp = await raydium.clmm.openPositionFromBase({
      poolInfo: info,
      poolKeys,
      tickLower: tickAt(0.5),
      tickUpper: tickAt(2),
      base: "MintA",
      baseAmount: new BN(10_000 * UNIT),
      otherAmountMax: new BN(20_000 * UNIT),
      ownerInfo: { useSOLBalance: false },
      nft2022: true,
      txVersion: TxVersion.V0,
    } as any);
    await lp.execute({ sendAndConfirm: true });
    walletPersonalPosition = lp.extInfo.personalPosition as PublicKey;

    // 4. Vault on TOKEN_A (fee wallet = admin ATA), the user creates a card and deposits 1000 TOKEN_A
    vault = vaultPdas(tokenA, tokenB);
    shareMint = pda(Buffer.from("share_mint"), tokenA.toBuffer());
    feeWallet = adminAta(tokenA);
    userCard = pda(Buffer.from("user_card"), vault.state.toBuffer(), user.publicKey.toBuffer());
    await initialize(program, provider, tokenA);
    const userProvider = new anchor.AnchorProvider(connection, new anchor.Wallet(user), provider.opts);
    await createCard(new Program<ClmmVault>(program.idl, userProvider), userProvider, tokenA);

    userTokenA = await createAccount(connection, admin, tokenA, user.publicKey);
    userShares = await createAccount(connection, admin, shareMint, user.publicKey);
    await mintTo(connection, admin, tokenA, userTokenA, admin, 1000 * UNIT);
    await userDeposit(1000 * UNIT);
    deposited = BigInt(990 * UNIT); // 1% fee went to the admin fee wallet
    assert.equal(await balance(vault.accA), deposited);
  });

  // ─── add_pair_token ────────────────────────────────────────────────────────

  it("add_pair_token: non-admin — Unauthorized", async () => {
    await expectError(() => addPairToken(vault, user), "Unauthorized");
  });

  it("add_pair_token: vault gets a TOKEN_B account", async () => {
    await addPairToken(vault);

    const state = await fetchVault(vault.state);
    assert.equal(state.tokenMintB.toBase58(), tokenB.toBase58());
    assert.equal(state.vaultTokenAccountB.toBase58(), vault.accB.toBase58());
    assert.equal(await balance(vault.accB), BigInt(0));
    const data = await connection.getAccountInfo(vault.state);
    assert.equal(data!.data.length, program.account.vaultState.size);
  });

  it("add_pair_token: the pair is set once", async () => {
    await expectError(() => addPairToken(vault), "already in use");
  });

  // ─── week 12: swap ─────────────────────────────────────────────────────────

  it("swap: non-admin — Unauthorized", async () => {
    await expectError(async () => (await vaultSwap(vault, new BN(10 * UNIT), new BN(0), true, { signer: user })).rpc(), "Unauthorized");
  });

  it("swap: pool of another pair (A / C) — WrongPool", async () => {
    await expectError(async () => (await vaultSwap(vault, new BN(10 * UNIT), new BN(0), true, { pool: otherPoolId })).rpc(), "WrongPool");
  });

  it("swap: pool vaults swapped — WrongPool", async () => {
    await expectError(
      async () => (await vaultSwap(vault, new BN(10 * UNIT), new BN(0), true, { swapPoolVaults: true })).rpc(),
      "WrongPool",
    );
  });

  it("swap: more than 50% of TOKEN_A in one swap — SwapTooLarge (extra task 7)", async () => {
    // 990 A in the vault: at most 495 A per swap
    await expectError(async () => (await vaultSwap(vault, new BN(496 * UNIT), new BN(0), true)).rpc(), "SwapTooLarge");
    await expectError(async () => (await vaultSwap(vault, U64_MAX, new BN(0), true, { quoteAmount: new BN(495 * UNIT) })).rpc(), "SwapTooLarge");
    assert.isFalse((await fetchVault(vault.state)).inMarket);
  });

  it("swap: min_amount_out above the real output — reverted", async () => {
    // 10 A at price ~1 give slightly less than 10 B (0.25% fee) — ask for exactly 10 B
    await expectError(async () => (await vaultSwap(vault, new BN(10 * UNIT), new BN(10 * UNIT), true)).rpc(), "TooLittleOutputReceived");
    assert.equal(await balance(vault.accA), deposited);
    assert.isFalse((await fetchVault(vault.state)).inMarket);
  });

  it("swap: vault swaps 300 A → B through the pool", async () => {
    const { res } = await quote(tokenA, new BN(300 * UNIT));
    await (await vaultSwap(vault, new BN(300 * UNIT), res.minAmountOut.amount.raw, true)).rpc();

    assert.equal(await balance(vault.accA), deposited - BigInt(300 * UNIT));
    const b = await balance(vault.accB);
    assert.isTrue(b > BigInt(290 * UNIT) && b < BigInt(300 * UNIT), `B after swap: ${b}`);

    const state = await fetchVault(vault.state);
    assert.isTrue(state.inMarket);
    assert.equal(state.totalTokens.toString(), deposited.toString()); // accounting frozen until sync_vault
  });

  it("deposit and withdraw are paused while funds are in the market", async () => {
    await mintTo(connection, admin, tokenA, userTokenA, admin, 1 * UNIT);
    await expectError(() => userDeposit(1 * UNIT), "InMarket");
    await expectError(() => userWithdraw(1 * UNIT), "InMarket");
  });

  it("sync_vault: TOKEN_B left — TokenBNotZero", async () => {
    await expectError(() => syncVault(vault).rpc(), "TokenBNotZero");
  });

  it("sync_vault: non-admin — Unauthorized", async () => {
    await expectError(() => syncVault(vault, user).rpc(), "Unauthorized");
  });

  // WEEK13_TESTS

  // ─── final: everything back to A ───────────────────────────────────────────

  it("swap all B → A + sync_vault in one transaction, even if someone sent B", async () => {
    // Someone sends the vault 1 unit of TOKEN_B right before the admin's swap
    await transfer(connection, admin, adminAta(tokenB), vault.accB, admin, 1);
    const allB = new BN((await balance(vault.accB)).toString());

    const { res } = await quote(tokenB, allB);
    const syncIx = await syncVault(vault).instruction();
    // amount_in = U64_MAX: the program takes the whole B balance at execution time
    await (await vaultSwap(vault, U64_MAX, res.minAmountOut.amount.raw, false, { quoteAmount: allB }))
      .postInstructions([syncIx])
      .rpc();

    assert.equal(await balance(vault.accB), BigInt(0));
    const state = await fetchVault(vault.state);
    const realA = await balance(vault.accA);
    assert.isFalse(state.inMarket);
    assert.equal(state.totalTokens.toString(), realA.toString());
    assert.notEqual(state.totalTokens.toString(), deposited.toString(), "swaps and fees must change the total");
    console.log(`  total_tokens: ${Number(deposited) / UNIT} → ${Number(realA) / UNIT}`);
  });

  it("withdraw: the user redeems all shares and gets all TOKEN_A of the vault", async () => {
    const before = await balance(userTokenA);
    const vaultA = await balance(vault.accA);

    await userWithdraw(await balance(userShares));

    assert.equal((await balance(userTokenA)) - before, vaultA);
    assert.equal(await balance(userShares), BigInt(0));
    assert.equal(await balance(vault.accA), BigInt(0));
  });

  it("swap B → A also puts the vault in the market; sync with no shares keeps surplus untracked", async () => {
    await transfer(connection, admin, adminAta(tokenB), vault.accB, admin, 10 * UNIT);
    const { res } = await quote(tokenB, new BN(10 * UNIT));
    assert.isFalse((await fetchVault(vault.state)).inMarket);

    await (await vaultSwap(vault, U64_MAX, res.minAmountOut.amount.raw, false, { quoteAmount: new BN(10 * UNIT) })).rpc();
    assert.isTrue((await fetchVault(vault.state)).inMarket);

    await syncVault(vault).rpc();
    const state = await fetchVault(vault.state);
    assert.isFalse(state.inMarket);
    // No shares → nobody to credit: total_tokens stays 0, the next deposit starts 1:1 again
    assert.equal(state.totalShares.toString(), "0");
    assert.equal(state.totalTokens.toString(), "0");
    assert.isTrue((await balance(vault.accA)) > BigInt(0));
  });

  it("after sync the vault accepts deposits again", async () => {
    await userDeposit(1 * UNIT);
    const state = await fetchVault(vault.state);
    assert.equal(state.totalTokens.toString(), "990000"); // 1 TOKEN_A minus the 1% fee
    assert.equal(state.totalShares.toString(), "990000");
  });
});
