// Ошибки контракта (VaultError в lib.rs) и кошелька → понятный текст.

const CONTRACT_ERRORS: Record<string, string> = {
  Unauthorized: "Это действие может выполнить только владелец карточки или админ vault.",
  VaultPaused: "Vault на паузе: внесение и создание карточек выключены. Вывести токены можно.",
  WrongVault: "Карточка относится к другому vault.",
  ZeroAmount: "Сумма должна быть больше нуля.",
  BelowMinimum: "Меньше минимального депозита (1 целый токен).",
  SharesTooSmall: "Сумма слишком мала: за неё не выйдет ни одного share.",
  MathOverflow: "Слишком большая сумма.",
  InvalidAccounting: "Учёт vault не сходится (внешний burn shares?). Операция заблокирована контрактом.",
  CardHasDeposits: "Карточку можно закрыть только после полного вывода.",
  AliasedAccount: "Нельзя вносить с кошелька, куда приходит комиссия (это кошелёк админа). Используйте другой кошелёк.",
  VaultEmpty: "В vault ещё никто не вносил токены.",
  WithdrawTooSmall: "Слишком мало shares: за них не выйдет ни одного токена.",
  InsufficientShares: "У вас меньше shares, чем вы хотите вывести.",
  SlippageExceeded: "Состояние vault изменилось, и вы получили бы меньше показанного. Обновите страницу и повторите.",
  InMarket: "Деньги vault сейчас в рынке (Raydium). Внесение и вывод откроются после sync_vault.",
  AccountNotInitialized: "Нужный аккаунт ещё не создан (карточка или токен-аккаунт). Обновите страницу.",
};

/** Имя ошибки Anchor (например "InMarket") из того, что бросил `.rpc()`. */
export function anchorErrorName(err: any): string | undefined {
  const direct = err?.error?.errorCode?.code ?? err?.errorCode?.code;
  if (typeof direct === "string") return direct;
  const text = [err?.message, ...(err?.logs ?? []), ...(err?.transactionLogs ?? [])].join("\n");
  return text.match(/Error Code: (\w+)/)?.[1];
}

export function describeError(err: any): string {
  const name = anchorErrorName(err);
  if (name) return CONTRACT_ERRORS[name] ?? `Контракт вернул ошибку ${name}.`;

  const text = [err?.message, ...(err?.logs ?? []), ...(err?.transactionLogs ?? [])].join("\n");
  // Первым: транзакция могла пройти — «повторите» привело бы к двойному депозиту
  if (/was not confirmed in|unknown if it succeeded|failed to confirm/i.test(text)) {
    return "Не дождались подтверждения — транзакция могла пройти. Обновите страницу и проверьте балансы, прежде чем повторять.";
  }
  if (err?.code === 4001 || /user rejected|rejected the request/i.test(text)) return "Вы отменили подпись в кошельке.";
  if (/no record of a prior credit|insufficient lamports|insufficient funds for (fee|rent)/i.test(text)) {
    return "Не хватает SOL на комиссию. Попросите админа: npm run faucet -- <ваш адрес>.";
  }
  // SPL Token: custom program error 0x1 = InsufficientFunds
  if (/custom program error: 0x1\b/.test(text)) return "Не хватает токенов на балансе.";
  if (/too many requests/i.test(text)) return "Devnet RPC просит подождать (лимит запросов). Попробуйте через минуту.";
  if (/blockhash not found|block height exceeded/i.test(text)) return "Транзакция не успела пройти. Попробуйте ещё раз.";
  if (err?.name === "TokenAccountNotFoundError") {
    return "Аккаунт токена не найден в devnet. Проверьте app/src/vault-config.json (админ: npm run setup-demo).";
  }
  return err?.message || err?.name || String(err);
}
