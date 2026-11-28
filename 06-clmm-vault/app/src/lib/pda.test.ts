import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { cardPda, shareMintPda, vaultAddresses, vaultPda, vaultTokensPda } from "./pda";

// Аккаунт, который создал сам контракт (W10, те же seeds ["vault", mint]): CI localnet,
// 05-withdrawal-vault/evidence/current-assignment/three-users.json. Зашит здесь, а не взят из
// vault-config.json: конфиг меняется после setup-demo, проверка seeds должна остаться.
const W10_PROGRAM = new PublicKey("CQCeERPQw6wkP3pPWatDdaGHgrHVTEEGUhA9yhJye5XM");
const W10_MINT = new PublicKey("4Vqb8eq4HwCAmwniLLdLVVJxgprayiHqveXShGehaYyp");
const W10_VAULT = "EBhC1iRxTuNApy3Fe2xshS4ujsoH7Rh8fSn6DNaTLSMN";

describe("PDA — те же seeds, что в lib.rs", () => {
  it("vault: [vault, token_mint] совпадает с аккаунтом, созданным контрактом", () => {
    expect(vaultPda(W10_PROGRAM, W10_MINT).toBase58()).toBe(W10_VAULT);
  });

  it("карточка: [user_card, vault, user], а не [user_card, user, vault]", () => {
    const vault = new PublicKey(W10_VAULT);
    const user = new PublicKey("9dxphrAwvbknrvjBnGg3FsN5nQooW3uLeK2kzJy9WiLG");
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), vault.toBuffer(), user.toBuffer()],
      W10_PROGRAM
    )[0];
    const swapped = PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), user.toBuffer(), vault.toBuffer()],
      W10_PROGRAM
    )[0];
    expect(cardPda(W10_PROGRAM, vault, user).equals(expected)).toBe(true);
    expect(cardPda(W10_PROGRAM, vault, user).equals(swapped)).toBe(false);
  });

  it("vault_tokens и share_mint — разные PDA от одного mint, все off-curve", () => {
    const a = vaultAddresses(W10_PROGRAM, W10_MINT);
    expect(a.vaultTokenAccount.equals(vaultTokensPda(W10_PROGRAM, W10_MINT))).toBe(true);
    expect(a.shareMint.equals(shareMintPda(W10_PROGRAM, W10_MINT))).toBe(true);
    const all = [a.vaultState, a.vaultTokenAccount, a.shareMint].map((k) => k.toBase58());
    expect(new Set(all).size).toBe(3);
    for (const k of [a.vaultState, a.vaultTokenAccount, a.shareMint]) expect(PublicKey.isOnCurve(k.toBytes())).toBe(false);
  });

  it("другая программа — другие адреса (PDA привязаны к program id)", () => {
    const other = new PublicKey("F4owJE4EFYLhcBnbPLHrwsuKLuLFFDnyYKAgARaJZaAx");
    expect(vaultPda(other, W10_MINT).toBase58()).not.toBe(W10_VAULT);
  });
});
