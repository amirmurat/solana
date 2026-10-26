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
  burn,
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
  closeCard,
  checkNetwork,
} from "../client/vault";

describe("W10 inherited deposits: actual SPL CPIs", () => {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const p = workspace.RaydiumVault as Program<RaydiumVault>;
  const payer = (provider.wallet as Wallet).payer;
  const users = [
    Keypair.generate(),
    Keypair.generate(),
    Keypair.generate(),
    Keypair.generate(),
  ];
  const ps = users.map(
    (k) =>
      new AnchorProvider(provider.connection, new Wallet(k), provider.opts),
  );
  const programs = ps.map((q) => new Program<RaydiumVault>(p.idl, q));
  let mint: PublicKey, fee: PublicKey;
  let a: ReturnType<typeof addresses>;
  const sources: PublicKey[] = [],
    destinations: PublicKey[] = [];
  async function fails(f: () => Promise<unknown>, code?: string) {
    let err: any;
    try {
      await f();
    } catch (e) {
      err = e;
    }
    expect(err, "must reject").not.eq(undefined);
    if (code) expect(err.error?.errorCode?.code).eq(code);
  }
  function ac(i: number) {
    return {
      vaultState: a.vaultState,
      userCard: addresses(p, mint, users[i].publicKey).userCard,
      vaultTokenAccount: a.vaultTokenAccount,
      shareMint: a.shareMint,
      userTokenAccount: sources[i],
      userShareAccount: destinations[i],
      feeWallet: fee,
      user: users[i].publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }
  const deposit = (i: number, n: number | bigint, overrides: object = {}) =>
    programs[i].methods
      .deposit(new BN(n.toString()))
      .accountsStrict({ ...ac(i), ...overrides })
      .rpc();
  async function snapshot(i = 0) {
    const v = await p.account.vaultState.fetch(a.vaultState);
    const card = await p.account.userCard.fetch(ac(i).userCard);
    return {
      source: (
        await getAccount(provider.connection, sources[i])
      ).amount.toString(),
      reserve: (
        await getAccount(provider.connection, a.vaultTokenAccount)
      ).amount.toString(),
      fee: (await getAccount(provider.connection, fee)).amount.toString(),
      supply: (
        await getMint(provider.connection, a.shareMint)
      ).supply.toString(),
      tokens: v.totalTokens.toString(),
      shares: v.totalShares.toString(),
      deposited: card.deposited.toString(),
      issued: card.shares.toString(),
    };
  }
  before(async () => {
    await checkNetwork(provider);
    mint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6,
    );
    a = addresses(p, mint, payer.publicKey);
    await initialize(p, provider, mint);
    fee = getAssociatedTokenAddressSync(mint, payer.publicKey);
    for (let i = 0; i < users.length; i++) {
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: users[i].publicKey,
            lamports: 100_000_000,
          }),
        ),
      );
      sources.push(
        await createAccount(
          provider.connection,
          payer,
          mint,
          users[i].publicKey,
        ),
      );
      destinations.push(
        await createAccount(
          provider.connection,
          payer,
          a.shareMint,
          users[i].publicKey,
        ),
      );
      await mintTo(
        provider.connection,
        payer,
        mint,
        sources[i],
        payer,
        500_000_000,
      );
      if (i < 3) await createCard(programs[i], ps[i], mint);
    }
  });
  it("minimum and share decimals follow the underlying mint (0 and 9)", async () => {
    for (const decimals of [0, 9]) {
      const m = await createMint(
        provider.connection,
        payer,
        payer.publicKey,
        null,
        decimals,
      );
      await initialize(p, provider, m);
      const b = addresses(p, m, payer.publicKey);
      expect(
        (await p.account.vaultState.fetch(b.vaultState)).minDeposit.toString(),
      ).eq((10n ** BigInt(decimals)).toString());
      expect((await getMint(provider.connection, b.shareMint)).decimals).eq(
        decimals,
      );
    }
  });
  it("stores fixed fee destination, one-token minimum and fresh account sizes", async () => {
    const v = await p.account.vaultState.fetch(a.vaultState);
    expect(v.minDeposit.toString()).eq("1000000");
    expect(v.feeWallet.equals(fee)).true;
    expect(
      (await provider.connection.getAccountInfo(a.vaultState))!.data.length,
    ).eq(323);
    expect(
      (await provider.connection.getAccountInfo(ac(0).userCard))!.data.length,
    ).eq(97);
  });
  it("three users deposit 100, 50, 25: exact balances, fee and shares 4:2:1", async () => {
    const amounts = [100_000_000, 50_000_000, 25_000_000];
    const signatures: string[] = [];
    for (let i = 0; i < 3; i++) {
      signatures.push(await deposit(i, amounts[i]));
      const net = (BigInt(amounts[i]) * 99n) / 100n;
      expect((await getAccount(provider.connection, sources[i])).amount).eq(
        500_000_000n - BigInt(amounts[i]),
      );
      expect(
        (await getAccount(provider.connection, destinations[i])).amount,
      ).eq(net);
      const card = await p.account.userCard.fetch(ac(i).userCard);
      expect(card.deposited.toString()).eq(net.toString());
      expect(card.shares.toString()).eq(net.toString());
    }
    const s = await snapshot();
    expect(s.tokens).eq("173250000");
    expect(s.reserve).eq(s.tokens);
    expect(s.supply).eq(s.shares);
    expect(s.fee).eq("1750000");
    const balances = await Promise.all(
      destinations.slice(0, 3).map((x) => getAccount(provider.connection, x)),
    );
    expect(balances[0].amount).eq(balances[2].amount * 4n);
    expect(balances[1].amount).eq(balances[2].amount * 2n);
    writeFileSync(
      "evidence/three-users.json",
      JSON.stringify(
        {
          cluster: provider.connection.rpcEndpoint,
          programId: p.programId.toBase58(),
          mint: mint.toBase58(),
          vault: a.vaultState.toBase58(),
          signatures,
          gross: amounts,
          shareBalances: balances.map((b) => b.amount.toString()),
          state: s,
        },
        null,
        2,
      ) + "\n",
    );
  });
  it("repeated deposits accumulate, with fee rounded down at base-unit precision", async () => {
    const before = await snapshot();
    await deposit(0, 1_000_001);
    const after = await snapshot();
    expect(BigInt(after.fee) - BigInt(before.fee)).eq(10_000n);
    expect(BigInt(after.tokens) - BigInt(before.tokens)).eq(990_001n);
    expect(BigInt(after.issued) - BigInt(before.issued)).eq(990_001n);
  });
  it("rejects zero and below-minimum deposits without any balance/state change", async () => {
    const before = await snapshot();
    await fails(() => deposit(0, 0), "ZeroAmount");
    await fails(() => deposit(0, 999_999), "BelowMinimum");
    expect(await snapshot()).deep.eq(before);
  });
  it("accepts exactly the minimum", async () => {
    await deposit(1, 1_000_000);
    expect(
      (await p.account.userCard.fetch(ac(1).userCard)).deposited.toString(),
    ).eq("50490000");
  });
  it("requires a previously created card", async () => {
    await fails(() => deposit(3, 1_000_000), "AccountNotInitialized");
    expect((await getAccount(provider.connection, sources[3])).amount).eq(
      500_000_000n,
    );
  });
  it("pause blocks deposit; resume restores it", async () => {
    await pause(p, provider, mint, true);
    const before = await snapshot();
    await fails(() => deposit(0, 1_000_000), "VaultPaused");
    expect(await snapshot()).deep.eq(before);
    await pause(p, provider, mint, false);
    await deposit(0, 1_000_000);
  });
  it("rejects an alternative fee account", async () => {
    const fake = await createAccount(
      provider.connection,
      payer,
      mint,
      payer.publicKey,
      Keypair.generate(),
    );
    const before = await snapshot();
    await fails(
      () => deposit(0, 1_000_000, { feeWallet: fake }),
      "ConstraintHasOne",
    );
    expect(await snapshot()).deep.eq(before);
  });
  it("rejects another users card, source and share destination", async () => {
    await fails(
      () => deposit(0, 1_000_000, { userCard: ac(1).userCard }),
      "ConstraintSeeds",
    );
    await fails(
      () => deposit(0, 1_000_000, { userTokenAccount: sources[1] }),
      "ConstraintTokenOwner",
    );
    await fails(
      () => deposit(0, 1_000_000, { userShareAccount: destinations[1] }),
      "ConstraintTokenOwner",
    );
  });
  it("rejects wrong underlying mint and wrong share mint", async () => {
    const other = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6,
    );
    const wrong = await createAccount(
      provider.connection,
      payer,
      other,
      users[0].publicKey,
    );
    await fails(
      () => deposit(0, 1_000_000, { userTokenAccount: wrong }),
      "ConstraintTokenMint",
    );
    await fails(
      () => deposit(0, 1_000_000, { userShareAccount: wrong }),
      "ConstraintTokenMint",
    );
    await fails(
      () => deposit(0, 1_000_000, { shareMint: other }),
      "ConstraintHasOne",
    );
  });
  it("rejects a substituted vault reserve", async () => {
    await fails(
      () => deposit(0, 1_000_000, { vaultTokenAccount: sources[0] }),
      "ConstraintHasOne",
    );
  });
  it("insufficient funds rolls back the already executed fee transfer", async () => {
    const before = await snapshot();
    await fails(() => deposit(0, 600_000_000));
    expect(await snapshot()).deep.eq(before);
  });
  it("requires the depositor signature", async () => {
    await fails(() =>
      p.methods.deposit(new BN(1_000_000)).accountsStrict(ac(0)).rpc(),
    );
  });
  it("cannot close/recreate a funded card to erase accounting", async () => {
    await fails(() => closeCard(programs[0], ps[0], mint), "CardHasDeposits");
    expect(
      (await p.account.userCard.fetch(ac(0).userCard)).deposited.toNumber(),
    ).greaterThan(0);
  });
  it("direct reserve donations cannot change the tracked share price", async () => {
    await transfer(
      provider.connection,
      payer,
      sources[2],
      a.vaultTokenAccount,
      users[2],
      1_000_000,
    );
    const before = await snapshot();
    await deposit(0, 1_000_000);
    const after = await snapshot();
    expect(BigInt(after.shares) - BigInt(before.shares)).eq(990_000n);
    expect(BigInt(after.reserve) - BigInt(after.tokens)).eq(1_000_000n);
  });
  it("rejects source equal to fee destination", async () => {
    await createCard(p, provider, mint);
    const adminAccounts = {
      ...ac(0),
      user: payer.publicKey,
      userCard: addresses(p, mint, payer.publicKey).userCard,
      userTokenAccount: fee,
      userShareAccount: await createAccount(
        provider.connection,
        payer,
        a.shareMint,
        payer.publicKey,
      ),
    };
    await fails(
      () =>
        p.methods
          .deposit(new BN(1_000_000))
          .accountsStrict(adminAccounts)
          .rpc(),
      "AliasedAccount",
    );
  });
  it("external share burns trigger explicit accounting error and no partial changes", async () => {
    await burn(
      provider.connection,
      payer,
      destinations[0],
      a.shareMint,
      users[0],
      1,
    );
    const before = await snapshot();
    await fails(() => deposit(0, 1_000_000), "InvalidAccounting");
    expect(await snapshot()).deep.eq(before);
  });
});
