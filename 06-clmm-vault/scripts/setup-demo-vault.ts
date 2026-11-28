/**
 * Неделя 14. Демо-vault для сайта (app/).
 *   1. проверяет, что программа clmm_vault задеплоена в devnet;
 *   2. создаёт TOKEN_A (6 знаков, mint authority = кошелёк админа);
 *   3. initialize_vault: VaultState, vault_tokens, share_mint; fee_wallet = ATA админа (комиссия 1%);
 *   4. пишет адреса в app/src/vault-config.json.
 *
 *   PROGRAM_ID=<id> ANCHOR_WALLET=~/.config/solana/id.json npm run setup-demo
 */
import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import idlJson from "../app/src/idl/clmm_vault.json";
import { APP_CONFIG, devnetConnection, errorText, loadAdmin, programId } from "./w14-devnet";

async function main() {
  const admin = loadAdmin();
  const connection = await devnetConnection();
  const id = programId();
  const info = await connection.getAccountInfo(id);
  if (!info?.executable) throw new Error(`Программа ${id.toBase58()} не найдена в devnet: сначала scripts/deploy-devnet.sh`);

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  const program: any = new anchor.Program({ ...(idlJson as any), address: id.toBase58() } as anchor.Idl, provider);
  console.log("Программа:", id.toBase58());
  console.log("Админ:", admin.publicKey.toBase58(), (await connection.getBalance(admin.publicKey)) / 1e9, "SOL");

  const tokenMint = await createMint(connection, admin, admin.publicKey, null, 6);
  console.log("TOKEN_A:", tokenMint.toBase58());

  const seed = (s: string) => PublicKey.findProgramAddressSync([Buffer.from(s), tokenMint.toBuffer()], id)[0];
  const feeWallet = getAssociatedTokenAddressSync(tokenMint, admin.publicKey);
  const sig = await program.methods
    .initializeVault()
    .accountsStrict({
      vaultState: seed("vault"),
      vaultTokenAccount: seed("vault_tokens"),
      shareMint: seed("share_mint"),
      tokenMint,
      feeWallet,
      admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, feeWallet, admin.publicKey, tokenMint)])
    .rpc();
  console.log("Vault:", seed("vault").toBase58());
  console.log("initialize_vault:", `https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  const config = {
    rpcUrl: "https://api.devnet.solana.com",
    programId: id.toBase58(),
    tokenMint: tokenMint.toBase58(),
    tokenSymbol: "TOKEN_A",
    admin: admin.publicKey.toBase58(),
  };
  if (fs.existsSync(APP_CONFIG)) {
    const old = JSON.parse(fs.readFileSync(APP_CONFIG, "utf8"));
    if (old.tokenMint) console.log(`Внимание: vault-config.json заменён, старый TOKEN_A ${old.tokenMint} (его vault в devnet остаётся).`);
  }
  fs.writeFileSync(APP_CONFIG, JSON.stringify(config, null, 2) + "\n");
  console.log(`Готово: ${path.relative(process.cwd(), APP_CONFIG)}. Токены пользователю: npm run faucet -- <адрес>`);
  return { ...config, vault: seed("vault").toBase58(), initializeSignature: sig };
}

main()
  .then((r) => {
    fs.mkdirSync(path.join(__dirname, "..", "evidence"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, "..", "evidence", "week14-setup-demo.json"), JSON.stringify(r, null, 2) + "\n");
  })
  .catch((e) => {
    console.error(errorText(e));
    process.exit(1);
  });
