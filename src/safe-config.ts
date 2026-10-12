import { Connection, Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import * as dotenv from "dotenv";

if (process.env.ENV_FILE) dotenv.config({path: process.env.ENV_FILE, quiet: true});
export const connection = new Connection("https://api.devnet.solana.com", "confirmed");
export async function assertDevnet() {
  if (await connection.getGenesisHash() !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
    throw new Error("Network rejected: expected Devnet");
  }
  console.log("Network verified: Devnet");
}
export function loadWallet(): Keypair {
  if (process.env.WALLET_PATH) {
    try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.WALLET_PATH, "utf8")))); }
    catch { throw new Error("Cannot load configured wallet"); }
  }
  if (process.env.SECRET_KEY) {
    try { return Keypair.fromSecretKey(bs58.decode(process.env.SECRET_KEY)); }
    catch { throw new Error("Invalid wallet configuration"); }
  }
  throw new Error("Set WALLET_PATH or configure SECRET_KEY privately outside the repository");
}
