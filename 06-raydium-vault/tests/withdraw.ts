import {
  AnchorProvider,
  BN,
  Program,
  Wallet,
  setProvider,
  workspace,
} from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getMint,
  transfer,
  freezeAccount,
  thawAccount,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import { writeFileSync } from "fs";
import { RaydiumVault } from "../target/types/raydium_vault";
import {
  addresses,
  initialize,
  createCard,
  pause,
  checkNetwork,
  deposit,
} from "../client/vault";

describe("W10 withdrawals: burn + PDA transfer", () => {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const p = workspace.RaydiumVault as Program<RaydiumVault>;
  const payer = (provider.wallet as Wallet).payer;
  const keys = Array.from({ length: 4 }, () => Keypair.generate());
  const providers = keys.map(
    (k) =>
      new AnchorProvider(provider.connection, new Wallet(k), provider.opts),
  );
  const programs = providers.map((q) => new Program<RaydiumVault>(p.idl, q));
  let mint: PublicKey, fee: PublicKey;
  let a: ReturnType<typeof addresses>;
  const sources: PublicKey[] = [],
    destinations: PublicKey[] = [],
    signatures: string[] = [];
  function accounts(i: number) {
    return {
      vaultState: a.vaultState,
      vaultTokenAccount: a.vaultTokenAccount,
      shareMint: a.shareMint,
      userTokenAccount: sources[i],
      userShareAccount: destinations[i],
      user: keys[i].publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }
  function redeem(
    i: number,
    shares: number | bigint,
    min = 0,
    overrides: object = {},
  ) {
    return programs[i].methods
      .withdraw(new BN(shares.toString()), new BN(min))
      .accountsStrict({ ...accounts(i), ...overrides })
      .rpc();
  }
  async function fails(f: () => Promise<unknown>, code?: string) {
    let e: any;
    try {
      await f();
    } catch (err) {
      e = err;
    }
    expect(e, "must reject").not.eq(undefined);
    if (code) expect(e.error?.errorCode?.code).eq(code);
  }
  async function snap(i = 0) {
    const v = await p.account.vaultState.fetch(a.vaultState);
    return {
      source: (
        await getAccount(provider.connection, sources[i])
      ).amount.toString(),
      balance: (
        await getAccount(provider.connection, destinations[i])
      ).amount.toString(),
      reserve: (
        await getAccount(provider.connection, a.vaultTokenAccount)
      ).amount.toString(),
      supply: (
        await getMint(provider.connection, a.shareMint)
      ).supply.toString(),
      tokens: v.totalTokens.toString(),
      shares: v.totalShares.toString(),
      fee: (await getAccount(provider.connection, fee)).amount.toString(),
    };
  }
  before(async () => {
    await checkNetwork(provider);
    mint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      payer.publicKey,
      6,
    );
    a = addresses(p, mint, payer.publicKey);
    await initialize(p, provider, mint);
    fee = getAssociatedTokenAddressSync(mint, payer.publicKey);
    for (let i = 0; i < 4; i++) {
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: keys[i].publicKey,
            lamports: 100_000_000,
          }),
        ),
      );
      sources.push(
        await createAccount(
          provider.connection,
          payer,
          mint,
          keys[i].publicKey,
        ),
      );
      destinations.push(
        await createAccount(
          provider.connection,
          payer,
          a.shareMint,
          keys[i].publicKey,
        ),
      );
      if (i < 3) {
        await createCard(programs[i], providers[i], mint);
        await mintTo(
          provider.connection,
          payer,
          mint,
          sources[i],
          payer,
          500_000_000,
        );
        await deposit(
          programs[i],
          providers[i],
          mint,
          BigInt([100_000_000, 50_000_000, 25_000_000][i]),
          sources[i],
          destinations[i],
        );
      }
    }
  });
  it("rejects zero with no state changes", async () => {
    const b = await snap();
    await fails(() => redeem(0, 0), "ZeroAmount");
    expect(await snap()).deep.eq(b);
  });
  it("rejects shares above the holder balance", async () => {
    const b = await snap();
    await fails(() => redeem(0, 100_000_000), "InsufficientShares");
    expect(await snap()).deep.eq(b);
  });
  it("enforces min_tokens_out before burning", async () => {
    const b = await snap();
    await fails(() => redeem(0, 1_000_000, 1_000_001), "SlippageExceeded");
    expect(await snap()).deep.eq(b);
  });
  it("rejects a different owners share source", async () => {
    await fails(
      () => redeem(0, 1_000_000, 0, { userShareAccount: destinations[1] }),
      "ConstraintTokenOwner",
    );
  });
  it("rejects a different owners token destination", async () => {
    await fails(
      () => redeem(0, 1_000_000, 0, { userTokenAccount: sources[1] }),
      "ConstraintTokenOwner",
    );
  });
  it("rejects a substituted reserve and share mint", async () => {
    await fails(
      () => redeem(0, 1_000_000, 0, { vaultTokenAccount: sources[0] }),
      "ConstraintHasOne",
    );
    await fails(
      () => redeem(0, 1_000_000, 0, { shareMint: mint }),
      "ConstraintHasOne",
    );
  });
  it("rejects token destinations with the wrong mint", async () => {
    const m = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6,
    );
    const wrong = await createAccount(
      provider.connection,
      payer,
      m,
      keys[0].publicKey,
    );
    await fails(
      () => redeem(0, 1_000_000, 0, { userTokenAccount: wrong }),
      "ConstraintTokenMint",
    );
  });
  it("requires the holders signature", async () => {
    await fails(() =>
      p.methods
        .withdraw(new BN(1_000_000), new BN(0))
        .accountsStrict(accounts(0))
        .rpc(),
    );
  });
  it("rolls back the burn if the token transfer fails on a frozen destination", async () => {
    await freezeAccount(provider.connection, payer, sources[0], mint, payer);
    const b = await snap();
    await fails(() => redeem(0, 1_000_000));
    expect(await snap()).deep.eq(b);
    await thawAccount(provider.connection, payer, sources[0], mint, payer);
  });
  it("allows withdrawal on pause while still rejecting deposits", async () => {
    await pause(p, provider, mint, true);
    await fails(
      () =>
        deposit(
          programs[0],
          providers[0],
          mint,
          1_000_000n,
          sources[0],
          destinations[0],
        ),
      "VaultPaused",
    );
    signatures.push(await redeem(0, 1_000_000, 1_000_000));
    expect((await getAccount(provider.connection, destinations[0])).amount).eq(
      98_000_000n,
    );
    await pause(p, provider, mint, false);
  });
  it("redeems transferred shares without requiring the recipients UserCard", async () => {
    await transfer(
      provider.connection,
      payer,
      destinations[0],
      destinations[3],
      keys[0],
      1_000_000,
    );
    expect(
      await provider.connection.getAccountInfo(
        addresses(p, mint, keys[3].publicKey).userCard,
      ),
    ).eq(null);
    signatures.push(await redeem(3, 1_000_000, 1_000_000));
    expect((await getAccount(provider.connection, sources[3])).amount).eq(
      1_000_000n,
    );
  });
  it("three users redeem all remaining shares: tracked vault and supply become zero", async () => {
    for (let i = 0; i < 3; i++) {
      const balance = (await getAccount(provider.connection, destinations[i]))
        .amount;
      signatures.push(await redeem(i, balance));
      expect(
        (await getAccount(provider.connection, destinations[i])).amount,
      ).eq(0n);
    }
    const result = await snap();
    expect(result.tokens).eq("0");
    expect(result.shares).eq("0");
    expect(result.reserve).eq("0");
    expect(result.supply).eq("0");
    expect(result.fee).eq("1750000");
    const finalBalances = await Promise.all(
      sources.map((x) => getAccount(provider.connection, x)),
    );
    expect(finalBalances.map((x) => x.amount)).deep.eq([
      498_000_000n,
      499_500_000n,
      499_750_000n,
      1_000_000n,
    ]);
    writeFileSync(
      "evidence/three-users-withdraw.json",
      JSON.stringify(
        {
          cluster: provider.connection.rpcEndpoint,
          programId: p.programId.toBase58(),
          mint: mint.toBase58(),
          signatures,
          result,
          finalUnderlyingBalances: finalBalances.map((x) =>
            x.amount.toString(),
          ),
        },
        null,
        2,
      ) + "\n",
    );
  });
  it("rejects a withdrawal from an empty vault", async () => {
    await fails(() => redeem(0, 1), "InsufficientShares");
  });
  it("supports a fresh first deposit after the last redemption", async () => {
    await deposit(
      programs[0],
      providers[0],
      mint,
      1_000_000n,
      sources[0],
      destinations[0],
    );
    expect((await getAccount(provider.connection, destinations[0])).amount).eq(
      990_000n,
    );
    expect(
      (await p.account.vaultState.fetch(a.vaultState)).totalTokens.toString(),
    ).eq("990000");
  });
});
