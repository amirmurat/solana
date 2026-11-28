// Какой vault показывает сайт. vault-config.json пишет `npm run setup-demo` (папка 06-clmm-vault).
// RPC можно переопределить в app/.env.local: VITE_RPC_URL=...
import { PublicKey } from "@solana/web3.js";
import cfg from "./vault-config.json";

export const RPC_URL: string = import.meta.env.VITE_RPC_URL || cfg.rpcUrl;
export const TOKEN_SYMBOL: string = cfg.tokenSymbol;

function key(value: string): PublicKey | null {
  try {
    return value ? new PublicKey(value) : null;
  } catch {
    return null;
  }
}

/**
 * Program ID берём из vault-config.json, а не из IDL: у W11–13 программы в git зашит
 * чужой (W10) адрес, а devnet-деплой W14 получает новую identity (см. README).
 * null — сайт ещё не настроен: админ не запускал setup-demo.
 */
export const PROGRAM_ID = key(cfg.programId);
export const TOKEN_MINT = key(cfg.tokenMint);
export const CONFIGURED = PROGRAM_ID !== null && TOKEN_MINT !== null;

export const EXPLORER = (kind: "tx" | "address", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
