// Общее для скриптов недели 14: кошелёк админа, защита от «не той сети», адрес программы.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const WALLET = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace(/^~/, os.homedir());
export const APP_CONFIG = path.join(__dirname, "..", "app", "src", "vault-config.json");

// Хеш genesis devnet. У mainnet/testnet другой — сеть не перепутать, даже если в DEVNET_RPC вставили mainnet.
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

// Эти программы W8/W9/W10 никогда не трогаем (как в deploy-devnet.sh).
const FOREIGN = [
  "2VY1E2cQrCA7usG83vShPUNMRqFTWWJKYkHNCiem16jM",
  "BjiFbMtqS8a5wj37pTNgGkAuNJ7urYjV1SG6WQxF18AX",
  "F4owJE4EFYLhcBnbPLHrwsuKLuLFFDnyYKAgARaJZaAx",
];

export async function devnetConnection(): Promise<Connection> {
  const connection = new Connection(RPC, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new Error(`${RPC} — не devnet (genesis ${genesis}). Скрипты работают только в devnet.`);
  return connection;
}

export function loadAdmin(): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET, "utf8"))));
}

/** PROGRAM_ID из env, иначе из target/deploy/clmm_vault-keypair.json (тот, что задеплоил deploy-devnet.sh). */
export function programId(): PublicKey {
  let id = process.env.PROGRAM_ID;
  if (!id) {
    const file = path.join(__dirname, "..", "target", "deploy", "clmm_vault-keypair.json");
    if (!fs.existsSync(file)) throw new Error("Задайте PROGRAM_ID=<адрес программы в devnet> или соберите проект (target/deploy)");
    id = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")))).publicKey.toBase58();
  }
  if (FOREIGN.includes(id)) throw new Error(`${id} — программа W8/W9/W10, для W14 нужен отдельный deploy`);
  return new PublicKey(id);
}

export function readAppConfig(): { rpcUrl: string; programId: string; tokenMint: string; tokenSymbol: string; admin: string } {
  return JSON.parse(fs.readFileSync(APP_CONFIG, "utf8"));
}

/** Текст ошибки: у ошибок spl-token message бывает пустым. */
export const errorText = (e: any) => e?.message || e?.name || String(e);
