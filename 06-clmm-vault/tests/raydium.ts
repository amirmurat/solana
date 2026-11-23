/**
 * Weeks 12–13: vault + real Raydium CLMM program (localnet with the Devnet binary, or Devnet).
 *
 * Setup (every run creates its own tokens and pools):
 *   - admin creates TOKEN_A / TOKEN_B / TOKEN_C and CLMM pools A/B (price 1) and A/C (empty, for WrongPool)
 *   - admin adds wallet liquidity to A/B (otherwise there is nothing to swap against)
 *   - vault for TOKEN_A, a user deposits 1000 TOKEN_A (1% fee → 990 tracked, 990 shares)
 *
 * Week 12: add_pair_token, swap 300 A → B, 50% limit, deposit/withdraw pause, rejections
 * Week 13: position, increase_liquidity, fees (counted in total_fees_a/b), close (rent back to admin), rejections
 * Final: swap all B → A + sync_vault in one transaction (even if someone sent B), user withdraws everything
 * Second vault (on TOKEN_B): a position without a swap also sets in_market; sync with a position → PositionOpen
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
import {
  Raydium,
  TxVersion,
  PoolUtils,
  TickUtils,
  PositionInfoLayout,
  getPdaTickArrayAddress,
  getPdaPersonalPositionAddress,
  getPdaExBitmapAccount,
} from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import { assert } from "chai";
import { ClmmVault } from "../target/types/clmm_vault";
import { initialize, createCard } from "../client/vault";
import { CLMM_PROGRAM_ID as CLMM, loadAmmConfig, loadRaydium, createPool } from "../scripts/create-clmm-pool";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const UNIT = 1_000_000; // decimals = 6
const U64_MAX = new BN("18446744073709551615"); // swap: "whole balance"
const TICK_SPACING = 60;

/** Accounts of one vault needed by the Raydium instructions */
interface VaultCtx {
  state: PublicKey;
  accA: PublicKey; // vault token (token_mint)
  accB: PublicKey; // second pair token
  mintA: PublicKey;
  mintB: PublicKey;
}

/** Open vault position */
interface PositionCtx {
  nft: Keypair;
  tickLower: number;
  tickUpper: number;
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
  let position: PositionCtx; // its position
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
  const startIndex = (t: number) => TickUtils.getTickArrayStartIndexByTick(t, TICK_SPACING);
  const positionLiquidity = async (nft: PublicKey) => {
    const info = await connection.getAccountInfo(getPdaPersonalPositionAddress(CLMM, nft).publicKey);
    return PositionInfoLayout.decode(info!.data).liquidity as BN;
  };

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

  /** Builder for vault::open_position (amounts in pool token order) */
  const openPosition = async (
    v: VaultCtx,
    p: PositionCtx,
    amount0: BN,
    amount1: BN,
    base0: boolean,
    opts: { signer?: Keypair; pool?: PublicKey } = {},
  ) => {
    const signer = opts.signer ?? admin;
    const { poolInfo: info, poolKeys } = await poolInfo();
    return program.methods
      .openPosition(p.tickLower, p.tickUpper, startIndex(p.tickLower), startIndex(p.tickUpper), amount0, amount1, base0)
      .accounts({
        admin: signer.publicKey,
        vaultState: v.state,
        vaultTokenAccount: v.accA,
        vaultTokenAccountB: v.accB,
        poolState: opts.pool ?? poolId,
        positionNftMint: p.nft.publicKey,
        positionNftAccount: getAssociatedTokenAddressSync(p.nft.publicKey, v.state, true, TOKEN_2022_PROGRAM_ID),
        personalPosition: getPdaPersonalPositionAddress(CLMM, p.nft.publicKey).publicKey,
        tickArrayLower: getPdaTickArrayAddress(CLMM, poolId, startIndex(p.tickLower)).publicKey,
        tickArrayUpper: getPdaTickArrayAddress(CLMM, poolId, startIndex(p.tickUpper)).publicKey,
        tokenVault0: new PublicKey(poolKeys.vault.A),
        tokenVault1: new PublicKey(poolKeys.vault.B),
        vault0Mint: new PublicKey(info.mintA.address),
        vault1Mint: new PublicKey(info.mintB.address),
        clmmProgram: CLMM,
      } as any)
      .remainingAccounts([writable(exBitmap())])
      .preInstructions([cu])
      .signers(signer === admin ? [p.nft] : [signer, p.nft]);
  };

  /** Accounts of the vault position for increase_liquidity / collect_fees / close_position */
  const positionAccounts = async (
    v: VaultCtx,
    p: PositionCtx,
    opts: { signer?: Keypair; personalPosition?: PublicKey } = {},
  ) => {
    const { poolKeys } = await poolInfo();
    return {
      admin: (opts.signer ?? admin).publicKey,
      vaultState: v.state,
      vaultTokenAccount: v.accA,
      vaultTokenAccountB: v.accB,
      poolState: poolId,
      positionNftMint: p.nft.publicKey,
      positionNftAccount: getAssociatedTokenAddressSync(p.nft.publicKey, v.state, true, TOKEN_2022_PROGRAM_ID),
      personalPosition: opts.personalPosition ?? getPdaPersonalPositionAddress(CLMM, p.nft.publicKey).publicKey,
      tokenVault0: new PublicKey(poolKeys.vault.A),
      tokenVault1: new PublicKey(poolKeys.vault.B),
      tickArrayLower: getPdaTickArrayAddress(CLMM, poolId, startIndex(p.tickLower)).publicKey,
      tickArrayUpper: getPdaTickArrayAddress(CLMM, poolId, startIndex(p.tickUpper)).publicKey,
      vault0Mint: new PublicKey(poolKeys.mintA.address),
      vault1Mint: new PublicKey(poolKeys.mintB.address),
      clmmProgram: CLMM,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
  };

  const increaseLiquidity = async (v: VaultCtx, p: PositionCtx, amount0: BN, amount1: BN, base0: boolean, opts: { signer?: Keypair } = {}) =>
    program.methods
      .increaseLiquidity(amount0, amount1, base0)
      .accounts((await positionAccounts(v, p, opts)) as any)
      .remainingAccounts([writable(exBitmap())])
      .preInstructions([cu])
      .signers(opts.signer ? [opts.signer] : []);

  const collectFees = async (v: VaultCtx, p: PositionCtx, opts: { signer?: Keypair; personalPosition?: PublicKey } = {}) =>
    program.methods
      .collectFees()
      .accounts((await positionAccounts(v, p, opts)) as any)
      .remainingAccounts([writable(exBitmap())])
      .preInstructions([cu])
      .signers(opts.signer ? [opts.signer] : []);

  const closePosition = async (v: VaultCtx, p: PositionCtx, opts: { signer?: Keypair } = {}) =>
    program.methods
      .closePosition(new BN(0), new BN(0))
      .accounts((await positionAccounts(v, p, opts)) as any)
      .remainingAccounts([writable(exBitmap())])
      .preInstructions([cu])
      .signers(opts.signer ? [opts.signer] : []);

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

  // ─── week 13: position ─────────────────────────────────────────────────────

  it("open_position: non-admin — Unauthorized", async () => {
    const p = { nft: Keypair.generate(), tickLower: -1200, tickUpper: 1200 };
    await expectError(async () => (await openPosition(vault, p, new BN(UNIT), new BN(UNIT), true, { signer: user })).rpc(), "Unauthorized");
  });

  it("open_position: pool of another pair — WrongPool", async () => {
    const p = { nft: Keypair.generate(), tickLower: -1200, tickUpper: 1200 };
    await expectError(async () => (await openPosition(vault, p, new BN(UNIT), new BN(UNIT), true, { pool: otherPoolId })).rpc(), "WrongPool");
  });

  it("open_position: tick_lower >= tick_upper — InvalidTickRange", async () => {
    const p = { nft: Keypair.generate(), tickLower: 1200, tickUpper: -1200 };
    await expectError(async () => (await openPosition(vault, p, new BN(UNIT), new BN(UNIT), true)).rpc(), "InvalidTickRange");
  });

  it("open_position: vault puts A and B into the range 0.8–1.25", async () => {
    const { poolInfo: info } = await poolInfo();
    const tickAt = (price: number) => TickUtils.getPriceAndTick({ poolInfo: info, price: new Decimal(price), baseIn: true }).tick;
    position = { nft: Keypair.generate(), tickLower: tickAt(0.8), tickUpper: tickAt(1.25) };

    const aBefore = await balance(vault.accA);
    const bBefore = await balance(vault.accB);
    const aIsToken0 = info.mintA.address === tokenA.toBase58();
    // base = token_0, 200 of it; the other token — as much as needed, at most what the vault has
    const amount1Max = new BN((aIsToken0 ? bBefore : aBefore).toString());
    await (await openPosition(vault, position, new BN(200 * UNIT), amount1Max, true)).rpc();

    const aAfter = await balance(vault.accA);
    const bAfter = await balance(vault.accB);
    const [spent0, spent1] = aIsToken0 ? [aBefore - aAfter, bBefore - bAfter] : [bBefore - bAfter, aBefore - aAfter];
    assert.isTrue(spent0 > BigInt(0) && spent0 <= BigInt(200 * UNIT), `token_0 spent: ${spent0}`);
    assert.isTrue(spent1 > BigInt(0), `token_1 spent: ${spent1}`);

    const state = await fetchVault(vault.state);
    assert.equal(state.positionNftMint.toBase58(), position.nft.publicKey.toBase58());

    // The position NFT belongs to the vault PDA and the admin allowance is revoked
    const nftAcc = await getAccount(
      connection,
      getAssociatedTokenAddressSync(position.nft.publicKey, vault.state, true, TOKEN_2022_PROGRAM_ID),
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    assert.equal(nftAcc.amount, BigInt(1));
    assert.equal(nftAcc.owner.toBase58(), vault.state.toBase58());
    for (const acc of [vault.accA, vault.accB]) {
      assert.isNull((await getAccount(connection, acc)).delegate, "delegate must be revoked");
    }
  });

  it("open_position: second position — PositionAlreadyOpen", async () => {
    const p = { ...position, nft: Keypair.generate() };
    await expectError(async () => (await openPosition(vault, p, new BN(UNIT), new BN(UNIT), true)).rpc(), "PositionAlreadyOpen");
  });

  it("increase_liquidity: non-admin — Unauthorized (extra task 8)", async () => {
    await expectError(async () => (await increaseLiquidity(vault, position, new BN(UNIT), new BN(UNIT), true, { signer: user })).rpc(), "Unauthorized");
  });

  it("increase_liquidity: vault adds tokens to the open position (extra task 8)", async () => {
    const { poolInfo: info } = await poolInfo();
    const aIsToken0 = info.mintA.address === tokenA.toBase58();
    const aBefore = await balance(vault.accA);
    const bBefore = await balance(vault.accB);
    const liquidityBefore = await positionLiquidity(position.nft.publicKey);

    const amount1Max = new BN((aIsToken0 ? bBefore : aBefore).toString());
    await (await increaseLiquidity(vault, position, new BN(50 * UNIT), amount1Max, true)).rpc();

    const liquidityAfter = await positionLiquidity(position.nft.publicKey);
    assert.isTrue(liquidityAfter.gt(liquidityBefore), `liquidity ${liquidityBefore} → ${liquidityAfter}`);
    const spent0 = aIsToken0 ? aBefore - (await balance(vault.accA)) : bBefore - (await balance(vault.accB));
    assert.isTrue(spent0 > BigInt(0) && spent0 <= BigInt(50 * UNIT), `token_0 spent: ${spent0}`);
    for (const acc of [vault.accA, vault.accB]) {
      assert.isNull((await getAccount(connection, acc)).delegate, "no allowance is used");
    }
  });

  it("collect_fees / close_position: non-admin — Unauthorized", async () => {
    await expectError(async () => (await collectFees(vault, position, { signer: user })).rpc(), "Unauthorized");
    await expectError(async () => (await closePosition(vault, position, { signer: user })).rpc(), "Unauthorized");
  });

  it("collect_fees: foreign position in the same pool — NoOpenPosition", async () => {
    await expectError(
      async () => (await collectFees(vault, position, { personalPosition: walletPersonalPosition })).rpc(),
      "NoOpenPosition",
    );
  });

  it("collect_fees: after trading the vault gets only fees, counted in total_fees_a/b (extra task 9)", async () => {
    // The wallet trades both ways — the vault position is in range and earns a share of fees
    await walletSwap(tokenA, new BN(1000 * UNIT));
    await walletSwap(tokenB, new BN(1000 * UNIT));

    const aBefore = await balance(vault.accA);
    const bBefore = await balance(vault.accB);
    const liquidityBefore = await positionLiquidity(position.nft.publicKey);
    assert.isTrue(liquidityBefore.gtn(0));
    const before = await fetchVault(vault.state);
    assert.equal(before.totalFeesA.toString(), "0");
    assert.equal(before.totalFeesB.toString(), "0");

    await (await collectFees(vault, position)).rpc();

    const gainA = (await balance(vault.accA)) - aBefore;
    const gainB = (await balance(vault.accB)) - bBefore;
    console.log(`  Fees: A +${gainA}, B +${gainB} (base units)`);
    // Swaps went both ways — fees in both tokens, and only fees (< 10 tokens), not the liquidity (~250 each)
    assert.isTrue(gainA > BigInt(0) && gainA < BigInt(10 * UNIT), `TOKEN_A fee: ${gainA}`);
    assert.isTrue(gainB > BigInt(0) && gainB < BigInt(10 * UNIT), `TOKEN_B fee: ${gainB}`);

    const after = await fetchVault(vault.state);
    assert.equal(after.totalFeesA.toString(), gainA.toString());
    assert.equal(after.totalFeesB.toString(), gainB.toString());

    // Position liquidity untouched
    assert.equal((await positionLiquidity(position.nft.publicKey)).toString(), liquidityBefore.toString());
    assert.equal(after.positionNftMint.toBase58(), position.nft.publicKey.toBase58());
  });

  it("close_position: liquidity back to the vault, rent to the admin, fee counter kept", async () => {
    const aBefore = await balance(vault.accA);
    const bBefore = await balance(vault.accB);
    const feesBefore = await fetchVault(vault.state);

    await (await closePosition(vault, position)).rpc();

    assert.isTrue((await balance(vault.accA)) > aBefore, "TOKEN_A returned");
    assert.isTrue((await balance(vault.accB)) > bBefore, "TOKEN_B returned");
    assert.isNull(await connection.getAccountInfo(getPdaPersonalPositionAddress(CLMM, position.nft.publicKey).publicKey));

    // No extra lamports left on the vault PDA: the position rent went to the admin
    const vaultInfo = await connection.getAccountInfo(vault.state);
    const minBalance = await connection.getMinimumBalanceForRentExemption(vaultInfo!.data.length);
    assert.equal(vaultInfo!.lamports, minBalance);

    const state = await fetchVault(vault.state);
    assert.equal(state.positionNftMint.toBase58(), PublicKey.default.toBase58());
    assert.isTrue(state.inMarket, "while TOKEN_B is held, the vault is still in the market");
    // No trades since collect_fees → nothing new to count
    assert.equal(state.totalFeesA.toString(), feesBefore.totalFeesA.toString());
    assert.equal(state.totalFeesB.toString(), feesBefore.totalFeesB.toString());
  });

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

  // ─── second vault: position without a prior swap ───────────────────────────

  describe("second vault (on TOKEN_B, pair — TOKEN_A)", () => {
    let vault2: VaultCtx;
    let position2: PositionCtx;

    before(async () => {
      vault2 = vaultPdas(tokenB, tokenA);
      await initialize(program, provider, tokenB);
      await addPairToken(vault2);
      // 50 TOKEN_B straight into vault2 (deposits are not needed to test the position)
      await transfer(connection, admin, adminAta(tokenB), vault2.accA, admin, 50 * UNIT);
    });

    it("open_position without a swap sets in_market (single-token position out of range)", async () => {
      const { poolInfo: info, computePoolInfo } = await poolInfo();
      const bIsToken0 = info.mintA.address === tokenB.toBase58();
      const current = Math.floor(computePoolInfo.tickCurrent / TICK_SPACING) * TICK_SPACING;
      // Only token_0 is needed above the current price, only token_1 below it
      const [tickLower, tickUpper] = bIsToken0 ? [current + 600, current + 1200] : [current - 1200, current - 600];
      position2 = { nft: Keypair.generate(), tickLower, tickUpper };
      const amount = new BN(50 * UNIT);

      assert.isFalse((await fetchVault(vault2.state)).inMarket);
      await (await openPosition(vault2, position2, bIsToken0 ? amount : new BN(0), bIsToken0 ? new BN(0) : amount, bIsToken0)).rpc();

      const state = await fetchVault(vault2.state);
      assert.isTrue(state.inMarket, "an open position must set in_market even without a swap");
      assert.equal(await balance(vault2.accB), BigInt(0), "vault2's second token was not spent");
    });

    it("sync_vault: TOKEN_B = 0 but the position is open — PositionOpen", async () => {
      await expectError(() => syncVault(vault2).rpc(), "PositionOpen");
    });

    it("close_position (no fees accrued) + sync_vault: vault2 back to normal", async () => {
      await (await closePosition(vault2, position2)).rpc();
      await syncVault(vault2).rpc();

      const state = await fetchVault(vault2.state);
      assert.isFalse(state.inMarket);
      assert.equal(state.totalFeesA.toString(), "0");
      assert.equal(state.totalFeesB.toString(), "0");
      // vault2 has no shares: its tokens stay untracked surplus
      assert.equal(state.totalTokens.toString(), "0");
      assert.isTrue((await balance(vault2.accA)) > BigInt(49 * UNIT));
    });
  });
});
