import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  PublicKey,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { connection, assertDevnet, loadWallet } from "./safe-config";

async function getBalance(pubkey: PublicKey): Promise<number> {
  const lamports = await connection.getBalance(pubkey);
  return lamports / LAMPORTS_PER_SOL;
}

async function airdrop(keypair: Keypair, sol: number): Promise<void> {
  console.log(`\n💧 Airdrop ${sol} SOL...`);
  const sig = await connection.requestAirdrop(
    keypair.publicKey,
    sol * LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(sig);
  const balance = await getBalance(keypair.publicKey);
  console.log(`✅ Done! Balance: ${balance} SOL`);
}

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

function createMemoInstruction(message: string): TransactionInstruction {
  return new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(message, "utf-8"),
  });
}

async function sendWithMemo(
  sender: Keypair,
  recipient: PublicKey,
  solAmount: number,
  memo: string
): Promise<void> {
  console.log(`\n🚀 Sending ${solAmount} SOL to ${recipient.toBase58()}`);
  console.log(`📝 Memo: "${memo}"`);

  const transaction = new Transaction();

  transaction.add(
    SystemProgram.transfer({
      fromPubkey: sender.publicKey,
      toPubkey: recipient,
      lamports: solAmount * LAMPORTS_PER_SOL,
    })
  );

  transaction.add(createMemoInstruction(memo));

  const signature = await sendAndConfirmTransaction(connection, transaction, [
    sender,
  ]);

  const txInfo = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  const slot = txInfo?.slot ?? "unknown";

  console.log("\n─────────────────────────────────────");
  console.log("✅ Transaction confirmed!");
  console.log("📋 Signature:", signature);
  console.log("🔢 Slot:     ", slot);
  console.log(
    "🔗 Explorer: ",
    `https://explorer.solana.com/tx/${signature}?cluster=devnet`
  );
  console.log("─────────────────────────────────────");
}

async function main() {
  await assertDevnet();
  const sender = loadWallet();
  console.log("Sender:", sender.publicKey.toBase58());
  const recipient = Keypair.generate();
  console.log("📭 Recipient:", recipient.publicKey.toBase58());


  const balanceBefore = await getBalance(sender.publicKey);
  console.log(`\n💰 Balance before: ${balanceBefore} SOL`);

  await sendWithMemo(sender, recipient.publicKey, 0.01, "Hello Solana");

  const balanceAfter = await getBalance(sender.publicKey);
  console.log(`💰 Balance after:  ${balanceAfter} SOL`);
}

main().catch(() => { console.error("Practice failed; check wallet configuration and Devnet balance"); process.exitCode = 1; });