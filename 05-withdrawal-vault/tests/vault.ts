import {
  AnchorProvider,
  Program,
  Wallet,
  workspace,
  setProvider,
} from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createMint,
  getMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { W10Vault } from "../target/types/w10_vault";
import {
  addresses,
  checkNetwork,
  initialize,
  createCard,
  pause,
  closeCard,
} from "../client/vault";
describe("W10 inherited card integration", () => {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const p = workspace.W10Vault as Program<W10Vault>;
  const payer = (provider.wallet as Wallet).payer;
  const second = Keypair.generate(),
    third = Keypair.generate();
  const bProvider = new AnchorProvider(
    provider.connection,
    new Wallet(second),
    provider.opts,
  );
  const cProvider = new AnchorProvider(
    provider.connection,
    new Wallet(third),
    provider.opts,
  );
  const bProgram = new Program<W10Vault>(p.idl, bProvider),
    cProgram = new Program<W10Vault>(p.idl, cProvider);
  let mint: PublicKey;
  let a: ReturnType<typeof addresses>;
  async function rejects(action: () => Promise<unknown>, code?: string) {
    let e: any;
    try {
      await action();
    } catch (err) {
      e = err;
    }
    expect(e, "must fail").not.equal(undefined);
    if (code) expect(e.error?.errorCode?.code).equal(code);
  }
  before(async () => {
    expect(await checkNetwork(provider)).equal("localnet");
    mint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6,
    );
    a = addresses(p, mint, payer.publicKey);
    for (const user of [second, third])
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: user.publicKey,
            lamports: 100_000_000,
          }),
        ),
      );
  });
  it("initializes official vault accounts with PDA authority and zero supply", async () => {
    await initialize(p, provider, mint);
    const v = await p.account.vaultState.fetch(a.vaultState);
    expect(v.admin.equals(payer.publicKey)).true;
    expect(v.tokenMint.equals(mint)).true;
    expect(v.shareMint.equals(a.shareMint)).true;
    expect(v.vaultTokenAccount.equals(a.vaultTokenAccount)).true;
    expect(v.paused).false;
    const m = await getMint(provider.connection, a.shareMint),
      t = await getAccount(provider.connection, a.vaultTokenAccount);
    expect(m.mintAuthority?.equals(a.vaultState)).true;
    expect(m.freezeAuthority).equal(null);
    expect(m.supply).equal(0n);
    expect(m.decimals).equal(6);
    expect(t.owner.equals(a.vaultState)).true;
    expect(t.mint.equals(mint)).true;
    expect(t.amount).equal(0n);
    expect(
      (await provider.connection.getAccountInfo(a.vaultState))?.owner.equals(
        p.programId,
      ),
    ).true;
    expect(
      (await provider.connection.getAccountInfo(a.shareMint))?.owner.equals(
        TOKEN_PROGRAM_ID,
      ),
    ).true;
  });
  it("creates card with owner vault and a blockchain timestamp", async () => {
    const before = Math.floor(Date.now() / 1000);
    await createCard(p, provider, mint);
    const card = await p.account.userCard.fetch(a.userCard);
    expect(card.owner.equals(payer.publicKey)).true;
    expect(card.vault.equals(a.vaultState)).true;
    expect(card.createdAt.toNumber()).within(
      before - 30,
      Math.floor(Date.now() / 1000) + 30,
    );
    expect(
      (await provider.connection.getAccountInfo(a.userCard))?.data.length,
    ).equal(97);
  });
  it("isolates two users cards", async () => {
    await createCard(bProgram, bProvider, mint);
    const b = addresses(p, mint, second.publicKey);
    expect(b.userCard.equals(a.userCard)).false;
    expect(
      (await p.account.userCard.fetch(b.userCard)).owner.equals(
        second.publicKey,
      ),
    ).true;
  });
  it("rejects duplicate vault initialization", async () => {
    await rejects(() => initialize(p, provider, mint));
  });
  it("rejects duplicate user card", async () => {
    await rejects(() => createCard(p, provider, mint));
  });
  it("rejects a forged card PDA without leaving an account", async () => {
    const fake = Keypair.generate().publicKey;
    await rejects(
      () =>
        p.methods
          .createUserCard()
          .accountsStrict({
            vaultState: a.vaultState,
            userCard: fake,
            user: payer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
      "ConstraintSeeds",
    );
    expect(await provider.connection.getAccountInfo(fake)).equal(null);
  });
  it("requires the user signature", async () => {
    const unknown = Keypair.generate().publicKey;
    const b = addresses(p, mint, unknown);
    await rejects(() =>
      p.methods
        .createUserCard()
        .accountsStrict({
          vaultState: a.vaultState,
          userCard: b.userCard,
          user: unknown,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
    );
    expect(await provider.connection.getAccountInfo(b.userCard)).equal(null);
  });
  it("rejects pause by a non-admin and preserves the flag", async () => {
    await rejects(() => pause(bProgram, bProvider, mint, true), "Unauthorized");
    expect((await p.account.vaultState.fetch(a.vaultState)).paused).false;
  });
  it("admin can pause", async () => {
    await pause(p, provider, mint, true);
    expect((await p.account.vaultState.fetch(a.vaultState)).paused).true;
  });
  it("paused vault rejects new cards and rolls back rent allocation", async () => {
    await rejects(() => createCard(cProgram, cProvider, mint), "VaultPaused");
    expect(
      await provider.connection.getAccountInfo(
        addresses(p, mint, third.publicKey).userCard,
      ),
    ).equal(null);
  });
  it("rejects closing someone else's card and preserves it", async () => {
    await rejects(
      () =>
        bProgram.methods
          .closeUserCard()
          .accountsStrict({
            vaultState: a.vaultState,
            userCard: a.userCard,
            user: second.publicKey,
          })
          .rpc(),
      "Unauthorized",
    );
    expect(
      (await p.account.userCard.fetch(a.userCard)).owner.equals(
        payer.publicKey,
      ),
    ).true;
  });
  it("owner can close even while paused and receives all rent minus transaction fee", async () => {
    const info = await provider.connection.getAccountInfo(a.userCard);
    const before = await provider.connection.getBalance(payer.publicKey);
    const sig = await closeCard(p, provider, mint);
    let tx = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    for (let i = 0; !tx && i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      tx = await provider.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
    }
    expect(tx?.meta?.err).equal(null);
    const after = await provider.connection.getBalance(payer.publicKey);
    expect(after - before).equal(info!.lamports - tx!.meta!.fee);
    expect(await provider.connection.getAccountInfo(a.userCard)).equal(null);
  });
  it("rejects closing an already closed card", async () => {
    await rejects(() => closeCard(p, provider, mint));
  });
  it("admin resumes and owner can recreate the closed card", async () => {
    await pause(p, provider, mint, false);
    await createCard(p, provider, mint);
    expect(
      (await p.account.userCard.fetch(a.userCard)).createdAt.toNumber(),
    ).greaterThan(0);
    await createCard(cProgram, cProvider, mint);
  });
  it("rejects a card from another vault", async () => {
    const other = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6,
    );
    await initialize(p, provider, other);
    const b = addresses(p, other, payer.publicKey);
    await rejects(
      () =>
        p.methods
          .closeUserCard()
          .accountsStrict({
            vaultState: b.vaultState,
            userCard: a.userCard,
            user: payer.publicKey,
          })
          .rpc(),
      "ConstraintSeeds",
    );
    expect(await provider.connection.getAccountInfo(a.userCard)).not.equal(
      null,
    );
  });
  it("administrator cannot mint shares directly", async () => {
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      a.shareMint,
      payer.publicKey,
    );
    await rejects(() =>
      mintTo(provider.connection, payer, a.shareMint, ata.address, payer, 1),
    );
    expect((await getMint(provider.connection, a.shareMint)).supply).equal(0n);
  });
});
