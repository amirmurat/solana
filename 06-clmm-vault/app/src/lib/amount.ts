// Суммы в контракте — целые u64 в минимальных единицах. TOKEN_A: 6 знаков, 1.5 = 1_500_000.
// Только bigint, без float: 0.1 + 0.2 в float = 0.30000000000000004.

export const U64_MAX = (1n << 64n) - 1n;

export function parseAmount(input: string, decimals: number): bigint {
  const text = input.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("Введите число, например 10 или 2.5");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`Не больше ${decimals} знаков после точки`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (raw > U64_MAX) throw new Error("Слишком большая сумма");
  return raw;
}

export function formatAmount(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
