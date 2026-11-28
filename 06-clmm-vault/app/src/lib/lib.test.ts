import { describe, expect, it } from "vitest";
import { U64_MAX, formatAmount, parseAmount } from "./amount";
import { quoteDeposit, quoteWithdraw, sharePrice } from "./math";
import { anchorErrorName, describeError } from "./errors";
import { blockedActions } from "./guards";
import idl from "../idl/clmm_vault.json";

describe("parseAmount / formatAmount", () => {
  it("переводит в минимальные единицы, запятая = точка", () => {
    expect(parseAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseAmount("1,5", 6)).toBe(1_500_000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(parseAmount("7", 6)).toBe(7_000_000n);
  });
  it("не теряет точность там, где float округлил бы (2^53 + 1)", () => {
    expect(parseAmount("9007199254.740993", 6)).toBe(9_007_199_254_740_993n);
    expect(formatAmount(9_007_199_254_740_993n, 6)).toBe("9007199254.740993");
  });
  it("отклоняет мусор, лишние знаки и > u64::MAX", () => {
    for (const bad of ["", "-1", "1e3", "1.", "1.0000001", "abc"]) expect(() => parseAmount(bad, 6)).toThrow();
    expect(parseAmount(formatAmount(U64_MAX, 6), 6)).toBe(U64_MAX);
    expect(() => parseAmount("18446744073709.551616", 6)).toThrow(/большая/);
  });
  it("formatAmount убирает хвостовые нули", () => {
    expect(formatAmount(1_500_000n, 6)).toBe("1.5");
    expect(formatAmount(1n, 6)).toBe("0.000001");
    expect(formatAmount(0n, 6)).toBe("0");
  });
});

describe("quoteDeposit — как quote() в lib.rs (комиссия 1%, floor)", () => {
  it("три пользователя 100/50/25 → shares 99/49.5/24.75, totals 173.25 (Rust test three_users)", () => {
    let [tokens, shares] = [0n, 0n];
    const issued: bigint[] = [];
    for (const amount of [100_000_000n, 50_000_000n, 25_000_000n]) {
      const q = quoteDeposit(amount, tokens, shares, 1_000_000n);
      if (!q.ok) throw new Error(q.reason);
      expect(q.fee).toBe(amount / 100n);
      expect(q.net).toBe(q.shares);
      tokens += q.net;
      shares += q.shares;
      issued.push(q.shares);
    }
    expect(issued).toEqual([99_000_000n, 49_500_000n, 24_750_000n]);
    expect([tokens, shares]).toEqual([173_250_000n, 173_250_000n]);
  });
  it("округление вниз: quote(101, 3, 2) = (1, 100, 66)", () => {
    expect(quoteDeposit(101n, 3n, 2n)).toEqual({ ok: true, fee: 1n, net: 100n, shares: 66n });
  });
  it("ошибки контракта: ZeroAmount, BelowMinimum, SharesTooSmall, InvalidAccounting", () => {
    expect(quoteDeposit(0n, 0n, 0n)).toEqual({ ok: false, reason: "ZeroAmount" });
    expect(quoteDeposit(999_999n, 0n, 0n, 1_000_000n)).toEqual({ ok: false, reason: "BelowMinimum" });
    expect(quoteDeposit(1n, 1000n, 1n)).toEqual({ ok: false, reason: "SharesTooSmall" });
    // отличие от эталона: у преподавателя «shares есть, токенов 0» = 1:1, у нас — ошибка, как в lib.rs
    expect(quoteDeposit(100n, 0n, 1n)).toEqual({ ok: false, reason: "InvalidAccounting" });
    expect(quoteDeposit(100n, 1n, 0n)).toEqual({ ok: false, reason: "InvalidAccounting" });
  });
  it("u64::MAX не теряет точность (в Rust — u128)", () => {
    const q = quoteDeposit(U64_MAX, U64_MAX, U64_MAX);
    expect(q.ok && q.net === q.shares).toBe(true);
  });
});

describe("quoteWithdraw — как quote_withdraw() в lib.rs", () => {
  it("частичный вывод вниз, последний забирает остаток", () => {
    expect(quoteWithdraw(1n, 10n, 3n)).toBe(3n);
    expect(quoteWithdraw(2n, 7n, 2n)).toBe(7n);
  });
  it("три пользователя выходят до нуля (Rust test three_users_exit)", () => {
    let [t, s] = [173_250_000n, 173_250_000n];
    for (const n of [99_000_000n, 49_500_000n, 24_750_000n]) {
      const out = quoteWithdraw(n, t, s);
      expect(out).toBe(n);
      t -= out;
      s -= n;
    }
    expect([t, s]).toEqual([0n, 0n]);
  });
  it("0 там, где контракт откажет: 0 shares, пустой vault, больше supply, пыль", () => {
    expect(quoteWithdraw(0n, 10n, 10n)).toBe(0n);
    expect(quoteWithdraw(1n, 0n, 0n)).toBe(0n);
    expect(quoteWithdraw(11n, 10n, 10n)).toBe(0n);
    expect(quoteWithdraw(1n, 1n, 10n)).toBe(0n);
  });
  it("цена share после прибыли/убытка", () => {
    expect(sharePrice(0n, 0n, 6)).toBe(1_000_000n);
    expect(sharePrice(1_100n, 1_000n, 6)).toBe(1_100_000n);
    expect(sharePrice(976_510_670n, 990_000_000n, 6)).toBe(986_374n);
  });
});

describe("blockedActions — require!() из lib.rs", () => {
  it("обычный режим — всё открыто", () => {
    expect(blockedActions({ paused: false, inMarket: false })).toEqual({});
  });
  it("пауза: депозит и карточка закрыты, вывод открыт", () => {
    const b = blockedActions({ paused: true, inMarket: false });
    expect(b.deposit).toMatch(/паузе/);
    expect(b.createCard).toMatch(/паузе/);
    expect(b.withdraw).toBeUndefined();
  });
  it("in_market: депозит и вывод закрыты, карточку создать можно", () => {
    const b = blockedActions({ paused: false, inMarket: true });
    expect(b.deposit).toMatch(/в рынке/);
    expect(b.withdraw).toMatch(/в рынке/);
    expect(b.createCard).toBeUndefined();
  });
});

describe("describeError", () => {
  it("имя ошибки Anchor из AnchorError и из логов", () => {
    expect(anchorErrorName({ error: { errorCode: { code: "InMarket", number: 6014 } } })).toBe("InMarket");
    expect(anchorErrorName({ message: "x", logs: ["Program log: AnchorError ... Error Code: BelowMinimum. Error Number: 6004."] })).toBe(
      "BelowMinimum"
    );
  });
  it("ошибки нашего контракта — понятный текст", () => {
    expect(describeError({ error: { errorCode: { code: "InMarket" } } })).toMatch(/в рынке/);
    expect(describeError({ error: { errorCode: { code: "VaultPaused" } } })).toMatch(/паузе/);
    expect(describeError({ error: { errorCode: { code: "SlippageExceeded" } } })).toMatch(/изменилось/);
    expect(describeError({ error: { errorCode: { code: "AliasedAccount" } } })).toMatch(/комиссия/);
  });
  it("у каждой ошибки из IDL, которую видит пользователь, есть текст (а не код)", () => {
    const userFacing = ["Unauthorized", "VaultPaused", "ZeroAmount", "BelowMinimum", "SharesTooSmall", "InvalidAccounting",
      "CardHasDeposits", "AliasedAccount", "WithdrawTooSmall", "InsufficientShares", "SlippageExceeded", "InMarket"];
    const names = idl.errors.map((e) => e.name);
    for (const n of userFacing) {
      expect(names).toContain(n);
      expect(describeError({ error: { errorCode: { code: n } } })).not.toMatch(/вернул ошибку/);
    }
  });
  it("коды ошибок в IDL идут с 6000 подряд, InMarket = 6014", () => {
    idl.errors.forEach((e, i) => expect(e.code).toBe(6000 + i));
    expect(idl.errors.find((e) => e.name === "InMarket")?.code).toBe(6014);
  });
  it("неизвестная ошибка контракта показывает имя", () => {
    expect(describeError({ error: { errorCode: { code: "WrongPool" } } })).toMatch(/WrongPool/);
  });
  it("кошелёк, SOL, лимиты, таймаут", () => {
    expect(describeError({ code: 4001, message: "User rejected the request." })).toMatch(/отменили/);
    expect(describeError({ message: "Attempt to debit an account but found no record of a prior credit." })).toMatch(/SOL/);
    expect(describeError({ message: "429 Too Many Requests" })).toMatch(/лимит/);
    expect(describeError({ message: "Blockhash not found" })).toMatch(/ещё раз/);
    const t = describeError({ message: "Transaction was not confirmed in 30.00 seconds. Check signature 3wGx429LTg" });
    expect(t).toMatch(/могла пройти/);
    expect(describeError({ message: "failed", logs: ["Program X consumed 14293 of 200000 compute units"] })).not.toMatch(/лимит/);
  });
  it("0x1 токен-программы — не хватает токенов, 0x10 — нет", () => {
    expect(describeError({ message: "custom program error: 0x1" })).toMatch(/токенов/);
    expect(describeError({ message: "custom program error: 0x10" })).not.toMatch(/токенов/);
  });
  it("пустой message не даёт пустой текст", () => {
    expect(describeError({ name: "TokenOwnerOffCurveError", message: "" })).toBe("TokenOwnerOffCurveError");
  });
});
