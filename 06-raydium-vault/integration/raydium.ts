import {
  AnchorProvider,
  Program,
  Wallet,
  BN,
  setProvider,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  transfer,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { readFileSync, writeFileSync } from "fs";
import { RaydiumVault } from "../target/types/raydium_vault";
import {
  addresses,
  initialize,
  createCard,
  deposit,
  withdraw,
} from "../client/vault";
import {
  configure,
  control,
  strategyAccounts,
  secondary,
  vaultSwap,
  openPosition,
  managePosition,
  Position,
} from "../client/strategy";
import {
  preparePool,
  guard,
  CoursePool,
  sdk,
  walletSwap,
} from "../scripts/clmm";
const idl = JSON.parse(readFileSync("target/idl/raydium_vault.json", "utf8"));

describe("W11–W13 with the official Raydium CLMM program", () => {
  const env = AnchorProvider.env();
  const provider = new AnchorProvider(
    new Connection(env.connection.rpcEndpoint, "confirmed"),
    env.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  setProvider(provider);
  const payer = (provider.wallet as Wallet).payer;
  const p = new Program<RaydiumVault>(idl as RaydiumVault, provider),
    user = Keypair.generate(),
    trader = Keypair.generate();
  const up = new AnchorProvider(
      provider.connection,
      new Wallet(user),
      provider.opts,
    ),
    userProgram = new Program<RaydiumVault>(p.idl, up);
  let state: CoursePool,
    mint: PublicKey,
    a: ReturnType<typeof addresses>,
    source: PublicKey,
    shareAccount: PublicKey,
    current: Position;
  const proof: any = { checks: [], transactions: [] };
  async function failed(action: () => Promise<unknown>, code?: string) {
    let err: any;
    try {
      await action();
    } catch (e) {
      err = e;
    }
    expect(err, "must reject").not.eq(undefined);
    if (code) expect(err.error?.errorCode?.code).eq(code);
  }
  async function balances() {
    const accounts = await strategyAccounts(p, provider, mint),
      v = await p.account.vaultState.fetch(a.vaultState);
    return {
      base: (
        await getAccount(provider.connection, a.vaultTokenAccount)
      ).amount.toString(),
      secondary: (
        await getAccount(provider.connection, accounts.secondaryAccount)
      ).amount.toString(),
      totalTokens: v.totalTokens.toString(),
      totalShares: v.totalShares.toString(),
      locked: v.strategyLocked,
      position: v.positionMint.toBase58(),
    };
  }
  async function tick() {
    return await (
      await sdk(provider.connection, payer)
    ).clmm.getRpcClmmPoolInfo({ poolId: new PublicKey(state.pool) });
  }
  function record(name: string, sig?: string) {
    proof.checks.push(name);
    if (sig) proof.transactions.push({ action: name, signature: sig });
  }
  before(async () => {
    proof.cluster = await guard(provider.connection);
    proof.programId = p.programId.toBase58();
    state = await preparePool(provider.connection, payer);
    proof.week11 = state;
    mint = new PublicKey(state.mintA);
    a = addresses(p, mint, payer.publicKey);
    if (await provider.connection.getAccountInfo(a.vaultState))
      throw Error(
        "This pool already has a vault for this program. Use a fresh local ledger/program for an independent integration run.",
      );
    await initialize(p, provider, mint);
    for (const k of [user, trader])
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: k.publicKey,
            lamports: 500_000_000,
          }),
        ),
      );
    source = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        mint,
        user.publicKey,
      )
    ).address;
    shareAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        a.shareMint,
        user.publicKey,
      )
    ).address;
    const ownerA = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        mint,
        payer.publicKey,
      ),
      ownerB = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        new PublicKey(state.mintB),
        payer.publicKey,
      );
    const traderA = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          payer,
          mint,
          trader.publicKey,
        )
      ).address,
      traderB = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          payer,
          new PublicKey(state.mintB),
          trader.publicKey,
        )
      ).address;
    await transfer(
      provider.connection,
      payer,
      ownerA.address,
      source,
      payer,
      2_000_000_000,
    );
    await transfer(
      provider.connection,
      payer,
      ownerA.address,
      traderA,
      payer,
      500_000_000_000,
    );
    await transfer(
      provider.connection,
      payer,
      ownerB.address,
      traderB,
      payer,
      500_000_000_000,
    );
    await createCard(userProgram, up, mint);
    await deposit(userProgram, up, mint, 1_000_000_000n, source, shareAccount);
  });
  after(function () {
    proof.finished = new Date().toISOString();
    proof.passedTests =
      this.test?.parent?.tests.filter((t) => t.state === "passed").length || 0;
    proof.allPassed = proof.passedTests === 16;
    writeFileSync(
      `evidence/weeks12-13-${proof.cluster || "unknown"}.json`,
      JSON.stringify(proof, null, 2) + "\n",
    );
  });
  it("W11 records own pool, tokens and manual liquidity position", async () => {
    expect(state.manualNft).not.eq("");
    expect((await tick()).liquidity.isZero()).false;
    record("own_pool_and_manual_position");
  });
  it("rejects configuration by a non-admin without creating the reserve", async () => {
    await failed(
      () =>
        configure(
          userProgram,
          up,
          mint,
          new PublicKey(state.mintB),
          new PublicKey(state.pool),
        ),
      "Unauthorized",
    );
    expect(
      await provider.connection.getAccountInfo(
        secondary(a.vaultState, p.programId),
      ),
    ).eq(null);
    record("configure_admin_only");
  });
  it("pins the pool pair and creates the PDA secondary reserve", async () => {
    const signature = await configure(
      p,
      provider,
      mint,
      new PublicKey(state.mintB),
      new PublicKey(state.pool),
    );
    expect(
      (
        await getAccount(
          provider.connection,
          secondary(a.vaultState, p.programId),
        )
      ).owner.equals(a.vaultState),
    ).true;
    record("configure_pool", signature);
  });
  it("locks user deposits and withdrawals during the strategy cycle", async () => {
    await failed(() => control(userProgram, up, mint, true), "Unauthorized");
    const signature = await control(p, provider, mint, true);
    await failed(
      () => deposit(userProgram, up, mint, 1_000_000n, source, shareAccount),
      "StrategyInProgress",
    );
    await failed(
      () =>
        withdraw(userProgram, up, mint, 1_000_000n, 0n, source, shareAccount),
      "StrategyInProgress",
    );
    record("strategy_lock", signature);
  });
  it("W12 records an on-chain slippage failure and rolls back balances", async () => {
    const before = await balances(),
      result = await vaultSwap(
        p,
        provider,
        payer,
        mint,
        new BN(400_000_000),
        true,
        true,
      );
    expect(result.error).not.eq(null);
    expect(JSON.stringify(result.error)).to.contain('"Custom":6018');
    expect(await balances()).deep.eq(before);
    proof.failedSlippage = result;
    record("slippage_failure", result.signature);
  });
  it("W12 swaps base to the second token and records price impact", async () => {
    const before = await tick(),
      result = await vaultSwap(
        p,
        provider,
        payer,
        mint,
        new BN(400_000_000),
        true,
      ),
      after = await tick();
    expect(after.sqrtPriceX64.eq(before.sqrtPriceX64)).false;
    expect(BigInt((await balances()).secondary) > 0n).true;
    proof.swap = {
      ...result,
      priceBefore: before.currentPrice,
      priceAfter: after.currentPrice,
    };
    record("vault_swap", result.signature);
  });
  it("prevents settlement while secondary-token assets remain", async () => {
    await failed(
      () => control(p, provider, mint, false),
      "InvalidStrategyState",
    );
    record("no_premature_settlement");
  });
  it("W13 opens a vault-owned NFT position and revokes temporary delegates", async () => {
    const opened = await openPosition(p, provider, payer, mint);
    current = opened.position;
    const nft = await getAccount(
      provider.connection,
      current.account,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    expect(nft.owner.equals(a.vaultState)).true;
    expect(nft.amount).eq(1n);
    expect(
      (await getAccount(provider.connection, a.vaultTokenAccount)).delegate,
    ).eq(null);
    expect(
      (
        await getAccount(
          provider.connection,
          secondary(a.vaultState, p.programId),
        )
      ).delegate,
    ).eq(null);
    proof.firstPosition = {
      ...opened,
      position: {
        nft: current.nft.toBase58(),
        lower: current.lower,
        upper: current.upper,
      },
    };
    record("open_vault_position", opened.signature);
  });
  it("blocks non-admin position operations and settlement with a live position", async () => {
    await failed(
      () => managePosition(userProgram, up, user, mint, current, false),
      "Unauthorized",
    );
    await failed(
      () => control(p, provider, mint, false),
      "InvalidStrategyState",
    );
    record("position_admin_only");
  });
  it("generates trading fees from an independent wallet", async () => {
    for (const direction of [true, false, true])
      record(
        "external_swap",
        await walletSwap(
          provider.connection,
          trader,
          new PublicKey(state.pool),
          new BN(1_000_000_000),
          direction,
        ),
      );
    record("fees_generated");
  });
  it("collects nonzero fees into vault accounts", async () => {
    const before = await balances(),
      signature = await managePosition(
        p,
        provider,
        payer,
        mint,
        current,
        false,
      ),
      after = await balances();
    const feeA = BigInt(after.base) - BigInt(before.base),
      feeB = BigInt(after.secondary) - BigInt(before.secondary);
    expect(feeA >= 0n && feeB >= 0n && feeA + feeB > 0n).true;
    proof.collectedFees = { base: feeA.toString(), secondary: feeB.toString() };
    record("collect_fees", signature);
  });
  it("moves the pool price outside the first vault range", async () => {
    let d = await tick(),
      count = 0;
    while (d.tickCurrent <= current.upper && count < 15) {
      record(
        "rebalance_external_swap",
        await walletSwap(
          provider.connection,
          trader,
          new PublicKey(state.pool),
          new BN(5_000_000_000),
          false,
        ),
      );
      d = await tick();
      count++;
    }
    expect(d.tickCurrent).greaterThan(current.upper);
    proof.outOfRange = {
      tick: d.tickCurrent,
      oldUpper: current.upper,
      price: d.currentPrice,
    };
    record("price_outside_range");
  });
  it("closes the first position and returns both assets", async () => {
    const before = await balances(),
      old = current,
      signature = await managePosition(p, provider, payer, mint, current, true);
    expect(await provider.connection.getAccountInfo(old.personal)).eq(null);
    const after = await balances();
    proof.firstClose = { before, after };
    expect(BigInt(after.base) + BigInt(after.secondary) > 0n).true;
    record("close_first_position", signature);
  });
  it("rebalances by opening and closing a new position around the new price", async () => {
    const opened = await openPosition(p, provider, payer, mint, "0.03");
    current = opened.position;
    const data = await tick();
    expect(data.tickCurrent > current.lower && data.tickCurrent < current.upper)
      .true;
    proof.rebalanced = {
      lower: current.lower,
      upper: current.upper,
      price: opened.price,
      openSignature: opened.signature,
    };
    const closeSig = await managePosition(
      p,
      provider,
      payer,
      mint,
      current,
      true,
    );
    record("rebalance_position", opened.signature);
    proof.transactions.push({
      action: "close_rebalanced_position",
      signature: closeSig,
    });
  });
  it("swaps all secondary assets back and settles realised NAV", async () => {
    const second = BigInt((await balances()).secondary);
    if (second > 0n)
      record(
        "swap_back",
        (
          await vaultSwap(
            p,
            provider,
            payer,
            mint,
            new BN(second.toString()),
            false,
          )
        ).signature,
      );
    const sig = await control(p, provider, mint, false),
      b = await balances();
    expect(b.secondary).eq("0");
    expect(b.locked).false;
    expect(b.base).eq(b.totalTokens);
    proof.settled = b;
    record("settle_nav", sig);
  });
  it("withdraws the final user shares and leaves no tracked assets or share supply", async () => {
    const v = await p.account.vaultState.fetch(a.vaultState),
      shares = (await getAccount(provider.connection, shareAccount)).amount,
      sig = await withdraw(
        userProgram,
        up,
        mint,
        shares,
        BigInt(v.totalTokens.toString()),
        source,
        shareAccount,
      ),
      b = await balances();
    expect(b.base).eq("0");
    expect(b.totalTokens).eq("0");
    expect(b.totalShares).eq("0");
    expect((await getMint(provider.connection, a.shareMint)).supply).eq(0n);
    proof.final = b;
    record("final_withdrawal", sig);
  });
});
