// Те же формулы, что quote() и quote_withdraw() в programs/clmm-vault/src/lib.rs.
// Деление целочисленное, вниз — как u128 в Rust. Отличие от эталона преподавателя:
// у нас комиссия 1% (floor) и минимальный депозит, а «одно из totals = 0» — ошибка, не 1:1.

export type DepositQuote =
  | { ok: true; fee: bigint; net: bigint; shares: bigint }
  | { ok: false; reason: "ZeroAmount" | "BelowMinimum" | "InvalidAccounting" | "SharesTooSmall" };

export function quoteDeposit(amount: bigint, totalTokens: bigint, totalShares: bigint, minDeposit = 0n): DepositQuote {
  if (amount <= 0n) return { ok: false, reason: "ZeroAmount" };
  if (amount < minDeposit) return { ok: false, reason: "BelowMinimum" };
  const fee = amount / 100n;
  const net = amount - fee;
  if ((totalTokens === 0n) !== (totalShares === 0n)) return { ok: false, reason: "InvalidAccounting" };
  const shares = totalShares === 0n ? net : (net * totalShares) / totalTokens;
  if (shares === 0n) return { ok: false, reason: "SharesTooSmall" };
  return { ok: true, fee, net, shares };
}

/** Сколько TOKEN_A отдаст withdraw за `shares`. 0 — контракт откажет (пусто / слишком мало). */
export function quoteWithdraw(shares: bigint, totalTokens: bigint, totalShares: bigint): bigint {
  if (shares <= 0n || totalShares === 0n || totalTokens === 0n || shares > totalShares) return 0n;
  return (shares * totalTokens) / totalShares;
}

/** Цена 1 целого share (10^decimals единиц) в минимальных единицах TOKEN_A. */
export function sharePrice(totalTokens: bigint, totalShares: bigint, decimals: number): bigint {
  const one = 10n ** BigInt(decimals);
  return totalShares === 0n ? one : (one * totalTokens) / totalShares;
}
