// Phantom без wallet-adapter: расширение кладёт в страницу `window.phantom.solana`
// с connect(), signTransaction() и signAllTransactions() — этого достаточно для Anchor.
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Signer } from "./client";

type AnyTx = Transaction | VersionedTransaction;

export interface BrowserWallet extends Signer {
  kind: "injected" | "dev";
  name: string;
  disconnect(): Promise<void>;
}

interface InjectedProvider {
  isPhantom?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signTransaction<T extends AnyTx>(tx: T): Promise<T>;
  signAllTransactions<T extends AnyTx>(txs: T[]): Promise<T[]>;
  on?(event: string, handler: (...args: any[]) => void): void;
  off?(event: string, handler: (...args: any[]) => void): void;
  removeListener?(event: string, handler: (...args: any[]) => void): void;
}

function injectedProvider(): InjectedProvider | undefined {
  const w = window as any;
  return w.phantom?.solana ?? w.solana;
}

export const hasInjectedWallet = () => injectedProvider() !== undefined;

export async function connectInjected(onlyIfTrusted = false): Promise<BrowserWallet> {
  const provider = injectedProvider();
  if (!provider) throw new Error("Кошелёк не найден. Установите Phantom: https://phantom.com");
  const { publicKey } = await provider.connect(onlyIfTrusted ? { onlyIfTrusted } : undefined);
  return {
    kind: "injected",
    name: provider.isPhantom ? "Phantom" : "Кошелёк",
    publicKey: new PublicKey(publicKey.toString()),
    signTransaction: (tx) => provider.signTransaction(tx),
    signAllTransactions: (txs) => provider.signAllTransactions(txs),
    disconnect: () => provider.disconnect(),
  };
}

/** События Phantom: смена аккаунта и отключение сайта в кошельке. Возвращает отписку. */
export function onInjectedEvent(event: "accountChanged" | "disconnect", handler: () => void): () => void {
  const provider = injectedProvider();
  provider?.on?.(event, handler);
  return () => (provider?.off ?? provider?.removeListener)?.call(provider, event, handler);
}

// ─── Тестовый кошелёк (только `yarn dev`) ────────────────────────────────────
// Ключ в localStorage — только для devnet. В `yarn build` код не попадает:
// App вызывает devWallet() лишь под import.meta.env.DEV.

const DEV_KEY = "clmm-vault:dev-wallet";

export function signWith<T extends AnyTx>(kp: Keypair, tx: T): T {
  if (tx instanceof VersionedTransaction) tx.sign([kp]);
  else tx.partialSign(kp);
  return tx;
}

/** Signer из Keypair: для тестового кошелька и devnet-сценария. */
export function keypairSigner(kp: Keypair): Signer {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx) => signWith(kp, tx),
    signAllTransactions: async (txs) => txs.map((tx) => signWith(kp, tx)),
  };
}

export function devWallet(): BrowserWallet {
  const saved = localStorage.getItem(DEV_KEY);
  const kp = saved ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved))) : Keypair.generate();
  if (!saved) localStorage.setItem(DEV_KEY, JSON.stringify(Array.from(kp.secretKey)));
  return { kind: "dev", name: "Тестовый кошелёк", ...keypairSigner(kp), disconnect: async () => {} };
}
