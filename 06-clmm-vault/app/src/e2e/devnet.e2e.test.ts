/**
 * Неделя 14. Сценарий сайта на настоящем devnet тем же кодом, что вызывают кнопки (lib/client.ts):
 * новый пользователь → faucet → create card → deposit → withdraw → withdraw_all → close card,
 * плюс реальные отказы контракта (BelowMinimum, VaultPaused) и их текст для пользователя.
 * Подписи и ссылки Explorer пишутся в ../evidence/week14-devnet-e2e.json.
 *
 *   DEVNET_ADMIN_KEYPAIR=~/.config/solana/id.json yarn e2e:devnet
 *
 * Phantom здесь не участвует: подписывает Keypair. Ручная проверка с Phantom — README, неделя 14.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import cfg from "../vault-config.json";
import { makeClient } from "../lib/client";
import { describeError } from "../lib/errors";
import { quoteDeposit, quoteWithdraw } from "../lib/math";
import { keypairSigner } from "../lib/wallet";

const env = (globalThis as any).process.env as Record<string, string | undefined>;
const RPC = env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const ADMIN = (env.DEVNET_ADMIN_KEYPAIR ?? "~/.config/solana/id.json").replace(/^~/, os.homedir());
const OUT = path.resolve(__dirname, "../../../evidence/week14-devnet-e2e.json");
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

describe.runIf(!!cfg.programId && !!cfg.tokenMint)("devnet: connect → card → deposit → withdraw", () => {
  it("проходит весь сценарий", { timeout: 300_000 }, async () => {
    const connection = new Connection(RPC, "confirmed");
    expect(await connection.getGenesisHash()).toBe(DEVNET_GENESIS); // никогда не mainnet

    const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN, "utf8"))));
    const mint = new PublicKey(cfg.tokenMint);
    const client = makeClient(connection, new PublicKey(cfg.programId), mint);
    const kp = Keypair.generate();
    const user = keypairSigner(kp);
    const steps: { step: string; signature: string; explorer: string }[] = [];
    const log = (step: string, signature: string) => steps.push({ step, signature, explorer: explorer(signature) });
    const rejected: { action: string; error: string; message: string }[] = [];

    // faucet: 0.05 SOL + 1000 TOKEN_A (как npm run faucet)
    const v0 = (await client.loadVault())!;
    expect(v0).not.toBeNull();
    const ata = getAssociatedTokenAddressSync(mint, kp.publicKey);
    const one = 10n ** BigInt(v0.decimals);
    log(
      "faucet",
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: kp.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
          createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata, kp.publicKey, mint),
          createMintToInstruction(mint, ata, admin.publicKey, 1000n * one)
        ),
        [admin],
        { commitment: "confirmed" }
      )
    );

    log("create_user_card", await client.createCard(user));
    expect((await client.loadUser(kp.publicKey)).card).toEqual(expect.objectContaining({ deposited: 0n, shares: 0n }));

    // Отказ контракта: меньше минимального депозита (симуляция падает, SOL не тратится)
    const below = await client.deposit(user, one - 1n, v0.feeWallet).then(() => "", (e) => e);
    expect(describeError(below)).toMatch(/минимального/);
    rejected.push({ action: "deposit(0.999999)", error: "BelowMinimum", message: describeError(below) });

    // deposit 100 TOKEN_A: комиссия 1, shares — по quote() из lib.rs
    let v = (await client.loadVault())!;
    const q = quoteDeposit(100n * one, v.totalTokens, v.totalShares, v.minDeposit);
    if (!q.ok) throw new Error(q.reason);
    log("deposit 100", await client.deposit(user, 100n * one, v.feeWallet));
    let u = await client.loadUser(kp.publicKey);
    expect(u.tokens).toBe(900n * one);
    expect(u.shares).toBe(q.shares);
    expect(u.card?.deposited).toBe(q.net);
    const after = (await client.loadVault())!;
    expect(after.totalTokens - v.totalTokens).toBe(q.net);
    expect(after.totalShares - v.totalShares).toBe(q.shares);

    // Пауза: депозит отклоняется (VaultPaused), вывод остаётся доступным
    let pausedWithdraw = "";
    if (!after.paused) {
      log("set_paused(true)", await client.setPaused(keypairSigner(admin), true));
      try {
        const e = await client.deposit(user, one, v.feeWallet).then(() => "", (err) => err);
        expect(describeError(e)).toMatch(/паузе/);
        rejected.push({ action: "deposit while paused", error: "VaultPaused", message: describeError(e) });
        v = (await client.loadVault())!;
        const s = 10n * one;
        pausedWithdraw = await client.withdraw(user, s, quoteWithdraw(s, v.totalTokens, v.totalShares));
        log("withdraw 10 shares while paused", pausedWithdraw);
      } finally {
        log("set_paused(false)", await client.setPaused(keypairSigner(admin), false));
      }
    }

    // withdraw 40 shares с min_tokens_out = превью
    v = (await client.loadVault())!;
    u = await client.loadUser(kp.publicKey);
    const part = 40n * one;
    const out = quoteWithdraw(part, v.totalTokens, v.totalShares);
    log("withdraw 40 shares", await client.withdraw(user, part, out));
    const u2 = await client.loadUser(kp.publicKey);
    expect(u2.shares).toBe(u.shares - part);
    expect(u2.tokens).toBe(u.tokens + out);

    // Отказ контракта: min_tokens_out больше, чем даст vault
    v = (await client.loadVault())!;
    const greedy = await client.withdraw(user, one, quoteWithdraw(one, v.totalTokens, v.totalShares) + 1n).then(() => "", (e) => e);
    expect(describeError(greedy)).toMatch(/изменилось/);
    rejected.push({ action: "withdraw(min_tokens_out = quote + 1)", error: "SlippageExceeded", message: describeError(greedy) });

    // withdraw_all → карточка обнуляется → закрываем, рента возвращается
    log("withdraw_all", await client.withdrawAll(user, client.previewAll(v, u2)));
    const u3 = await client.loadUser(kp.publicKey);
    expect(u3.shares).toBe(0n);
    expect(u3.card).toEqual(expect.objectContaining({ deposited: 0n, shares: 0n }));
    log("close_user_card", await client.closeCard(user));
    expect((await client.loadUser(kp.publicKey)).card).toBeNull();

    const final = (await client.loadVault())!;
    const evidence = {
      cluster: "devnet",
      date: new Date().toISOString(),
      programId: cfg.programId,
      tokenMint: cfg.tokenMint,
      vault: client.addresses.vaultState.toBase58(),
      user: kp.publicKey.toBase58(),
      signer: "Keypair (headless, тот же lib/client.ts, что у кнопок сайта; Phantom не участвовал)",
      steps,
      rejectedAsExpected: rejected,
      userTokensAfter: (await client.loadUser(kp.publicKey)).tokens.toString(),
      vaultAfter: { totalTokens: final.totalTokens.toString(), totalShares: final.totalShares.toString(), paused: final.paused },
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence, null, 2));
  });
});
