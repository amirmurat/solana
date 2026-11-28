// Всё общение с контрактом clmm_vault: чтение состояния и действия пользователя.
// Без import.meta/config — тот же код использует devnet-сценарий (src/e2e) из Node.
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import idlJson from "../idl/clmm_vault.json";
import { tokenBalance } from "./balance";
import { quoteWithdraw } from "./math";
import { vaultAddresses } from "./pda";

type AnyTx = Transaction | VersionedTransaction;

/** Минимум, который нужен Anchor для подписи: Phantom, тестовый кошелёк или Keypair в скрипте. */
export interface Signer {
  publicKey: PublicKey;
  signTransaction<T extends AnyTx>(tx: T): Promise<T>;
  signAllTransactions<T extends AnyTx>(txs: T[]): Promise<T[]>;
}

export interface VaultView {
  admin: PublicKey;
  feeWallet: PublicKey;
  decimals: number;
  totalTokens: bigint;
  totalShares: bigint;
  reserve: bigint; // реальный баланс vault_token_account (может быть > total_tokens из-за донатов)
  shareSupply: bigint;
  minDeposit: bigint;
  paused: boolean;
  inMarket: boolean;
  pairSet: boolean;
  positionOpen: boolean;
}

export interface UserView {
  sol: number;
  tokens: bigint;
  shares: bigint;
  card: { deposited: bigint; shares: bigint; createdAt: number } | null;
}

const toBig = (bn: BN) => BigInt(bn.toString());
const toBN = (n: bigint) => new BN(n.toString());

// Для чтения подпись не нужна: «кошелёк», который отказывается подписывать
const readOnlySigner: Signer = {
  publicKey: Keypair.generate().publicKey,
  signTransaction: () => Promise.reject(new Error("Подключите кошелёк")),
  signAllTransactions: () => Promise.reject(new Error("Подключите кошелёк")),
};

export function makeClient(connection: Connection, programId: PublicKey, mint: PublicKey) {
  const idl = { ...(idlJson as unknown as Idl), address: programId.toBase58() } as Idl;
  const addr = vaultAddresses(programId, mint);
  const programs = new WeakMap<Signer, Program>();

  function program(signer: Signer = readOnlySigner): Program {
    let p = programs.get(signer);
    if (!p) {
      p = new Program(idl, new AnchorProvider(connection, signer as any, { commitment: "confirmed" }));
      programs.set(signer, p);
    }
    return p;
  }
  // IDL не типизирован (подмножество, см. README) — методы и аккаунты как any, проверка в CI check-idl
  const m = (s: Signer) => program(s).methods as any;
  const accounts = () => program().account as any;

  /** null — vault для этого токена ещё не создан. */
  async function loadVault(): Promise<VaultView | null> {
    const s = await accounts().vaultState.fetchNullable(addr.vaultState);
    if (!s) return null;
    const [m, shareMint, reserve] = await Promise.all([
      getMint(connection, mint),
      getMint(connection, addr.shareMint),
      connection.getTokenAccountBalance(addr.vaultTokenAccount),
    ]);
    return {
      admin: s.admin,
      feeWallet: s.feeWallet,
      decimals: m.decimals,
      totalTokens: toBig(s.totalTokens),
      totalShares: toBig(s.totalShares),
      reserve: BigInt(reserve.value.amount),
      shareSupply: shareMint.supply,
      minDeposit: toBig(s.minDeposit),
      paused: s.paused,
      inMarket: s.inMarket,
      pairSet: !s.tokenMintB.equals(PublicKey.default),
      positionOpen: !s.positionNftMint.equals(PublicKey.default),
    };
  }

  async function loadUser(owner: PublicKey): Promise<UserView> {
    const [lamports, tokens, shares, card] = await Promise.all([
      connection.getBalance(owner),
      tokenBalance(connection, owner, mint),
      tokenBalance(connection, owner, addr.shareMint),
      accounts().userCard.fetchNullable(addr.card(owner)),
    ]);
    return {
      sol: lamports / 1e9,
      tokens,
      shares,
      card: card
        ? { deposited: toBig(card.deposited), shares: toBig(card.shares), createdAt: Number(card.createdAt) }
        : null,
    };
  }

  function userAccounts(user: PublicKey) {
    return {
      vaultState: addr.vaultState,
      userCard: addr.card(user),
      vaultTokenAccount: addr.vaultTokenAccount,
      shareMint: addr.shareMint,
      userTokenAccount: getAssociatedTokenAddressSync(mint, user),
      userShareAccount: getAssociatedTokenAddressSync(addr.shareMint, user),
      user,
    };
  }

  const ata = (payer: PublicKey, account: PublicKey, m: PublicKey) =>
    createAssociatedTokenAccountIdempotentInstruction(payer, account, payer, m);

  return {
    addresses: addr,
    mint,
    programId,
    loadVault,
    loadUser,

    createCard: (w: Signer): Promise<string> =>
      m(w).createUserCard()
        .accountsPartial({ vaultState: addr.vaultState, userCard: addr.card(w.publicKey), user: w.publicKey })
        .rpc(),

    /** deposit(amount). fee_wallet берём из VaultState. ATA для shares создаём в той же транзакции. */
    deposit: (w: Signer, amount: bigint, feeWallet: PublicKey): Promise<string> => {
      const a = userAccounts(w.publicKey);
      return m(w).deposit(toBN(amount))
        .accountsPartial({ ...a, feeWallet })
        .preInstructions([ata(w.publicKey, a.userShareAccount, addr.shareMint)])
        .rpc();
    },

    /**
     * withdraw(shares, min_tokens_out). minOut = ровно то, что показали пользователю:
     * если между превью и подписью состояние vault изменилось, контракт вернёт SlippageExceeded.
     */
    withdraw: (w: Signer, shares: bigint, minOut: bigint): Promise<string> => {
      const a = userAccounts(w.publicKey);
      return m(w).withdraw(toBN(shares), toBN(minOut))
        .accountsPartial(a)
        .preInstructions([ata(w.publicKey, a.userTokenAccount, mint)])
        .rpc();
    },

    withdrawAll: (w: Signer, minOut: bigint): Promise<string> => {
      const a = userAccounts(w.publicKey);
      return m(w).withdrawAll(toBN(minOut))
        .accountsPartial(a)
        .preInstructions([ata(w.publicKey, a.userTokenAccount, mint)])
        .rpc();
    },

    /** Закрыть пустую карточку: рента возвращается владельцу. */
    closeCard: (w: Signer): Promise<string> =>
      m(w).closeUserCard()
        .accountsPartial({ vaultState: addr.vaultState, userCard: addr.card(w.publicKey), user: w.publicKey })
        .rpc(),

    /** Только админ. */
    setPaused: (w: Signer, paused: boolean): Promise<string> =>
      m(w).setPaused(paused).accountsPartial({ vaultState: addr.vaultState, admin: w.publicKey }).rpc(),

    /** Превью для withdraw_all по свежему состоянию. */
    previewAll: (v: VaultView, u: UserView) => quoteWithdraw(u.shares, v.totalTokens, v.totalShares),
  };
}

export type VaultClient = ReturnType<typeof makeClient>;
