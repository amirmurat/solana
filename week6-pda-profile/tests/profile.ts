import { AnchorProvider, Program, Wallet, setProvider, workspace } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import { W6Profile } from "../target/types/w6_profile";
import { ProfileClient, checkNetwork } from "../client/profile";

describe("W6 PDA profile", () => {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.W6Profile as Program<W6Profile>;
  const client = new ProfileClient(program, provider);
  before(async () => {
    expect(await checkNetwork(provider.connection)).to.equal("localnet");
  });
  it("creates the wallet-derived PDA", async () => {
    await client.initialize("Alice", "First profile");
    const account = await client.read();
    expect(account.owner.equals(provider.wallet.publicKey)).to.equal(true);
    expect(account.name).to.equal("Alice");
    expect(account.bio).to.equal("First profile");
  });
  it("updates the profile as owner", async () => {
    await client.update("Alice updated", "Updated bio");
    const account = await client.read();
    expect(account.name).to.equal("Alice updated");
    expect(account.bio).to.equal("Updated bio");
  });
  it("reads persisted data and canonical PDA", async () => {
    const [expected, bump] = PublicKey.findProgramAddressSync([Buffer.from("profile"), provider.wallet.publicKey.toBuffer()], program.programId);
    expect(client.address().equals(expected)).to.equal(true);
    const account = await client.read();
    expect(account.bump).to.equal(bump);
    expect(account.bio).to.equal("Updated bio");
  });
  it("rejects another wallet and preserves the profile", async () => {
    await checkNetwork(provider.connection);
    const attacker = Keypair.generate();
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey, toPubkey: attacker.publicKey, lamports: LAMPORTS_PER_SOL / 10
    })));
    const attackerProvider = new AnchorProvider(provider.connection, new Wallet(attacker), provider.opts);
    const attackerProgram = new Program<W6Profile>(program.idl, attackerProvider);
    let code: string | undefined;
    try {
      await attackerProgram.methods.updateProfile("Hacked", "Hacked").accountsStrict({
        profile: client.address(), owner: attacker.publicKey
      }).rpc();
    } catch (error) { code = (error as {error?: {errorCode?: {code?: string}}}).error?.errorCode?.code; }
    expect(code).to.equal("Unauthorized");
    expect((await client.read()).name).to.equal("Alice updated");
  });
  it("rejects oversized UTF-8 data", async () => {
    let code: string | undefined;
    try { await client.update("я".repeat(17), "bio"); }
    catch (error) { code = (error as {error?: {errorCode?: {code?: string}}}).error?.errorCode?.code; }
    expect(code).to.equal("NameTooLong");
    expect((await client.read()).name).to.equal("Alice updated");
  });
});
