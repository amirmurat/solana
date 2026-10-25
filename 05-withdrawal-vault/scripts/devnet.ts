import {
  AnchorProvider,
  Program,
  Wallet,
  setProvider,
} from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getMint,
} from "@solana/spl-token";
import { writeFileSync } from "fs";
import { W10Vault } from "../target/types/w10_vault";
import idl from "../target/idl/w10_vault.json";
import {
  addresses,
  checkNetwork,
  initialize,
  createCard,
  deposit,
} from "../client/vault";
async function main() {
  const provider = AnchorProvider.env();
  setProvider(provider);
  if ((await checkNetwork(provider)) !== "devnet")
    throw Error("Devnet smoke requires official Devnet");
  const p = new Program<W10Vault>(idl as W10Vault, provider);
  const info = await provider.connection.getAccountInfo(p.programId);
  if (!info?.executable)
    throw Error(
      "Deploy this W9 program to Devnet before running the smoke test",
    );
  const payer = (provider.wallet as Wallet).payer;
  const mint = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    null,
    6,
  );
  const a = addresses(p, mint, payer.publicKey);
  const signatures = [
    await initialize(p, provider, mint),
    await createCard(p, provider, mint),
  ];
  // Separate source: admin ATA is the fixed fee destination.
  const source = await createAccount(
    provider.connection,
    payer,
    mint,
    payer.publicKey,
    Keypair.generate(),
  );
  const destination = await createAccount(
    provider.connection,
    payer,
    a.shareMint,
    payer.publicKey,
  );
  await mintTo(provider.connection, payer, mint, source, payer, 100_000_000);
  signatures.push(
    await deposit(p, provider, mint, 100_000_000n, source, destination),
  );
  const v = await p.account.vaultState.fetch(a.vaultState);
  const reserve = await getAccount(provider.connection, a.vaultTokenAccount),
    shares = await getAccount(provider.connection, destination),
    fee = await getAccount(provider.connection, v.feeWallet);
  if (
    reserve.amount !== 99_000_000n ||
    shares.amount !== 99_000_000n ||
    fee.amount !== 1_000_000n ||
    (await getMint(provider.connection, a.shareMint)).supply !== 99_000_000n
  )
    throw Error("Smoke balance assertion failed");
  const evidence = {
    cluster: "devnet",
    programId: p.programId.toBase58(),
    mint: mint.toBase58(),
    signatures,
    reserve: reserve.amount.toString(),
    shares: shares.amount.toString(),
    fee: fee.amount.toString(),
  };
  writeFileSync(
    "evidence/devnet-smoke.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(evidence);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
