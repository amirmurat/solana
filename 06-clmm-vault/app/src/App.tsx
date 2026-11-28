import { useCallback, useEffect, useRef, useState } from "react";
import { ActionForm, type Preview } from "./components/ActionForm";
import { CONFIGURED, EXPLORER, PROGRAM_ID, TOKEN_MINT, TOKEN_SYMBOL } from "./config";
import { formatAmount } from "./lib/amount";
import type { UserView, VaultView } from "./lib/client";
import { describeError } from "./lib/errors";
import { blockedActions } from "./lib/guards";
import { quoteDeposit, quoteWithdraw, sharePrice } from "./lib/math";
import { client } from "./lib/vault";
import { connectInjected, devWallet, hasInjectedWallet, onInjectedEvent, type BrowserWallet } from "./lib/wallet";

const MIN_SOL = 0.005; // примерно на карточку и пару токен-аккаунтов

type Status = { kind: "ok" | "error"; text: string; sig?: string } | null;

const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;
const Addr = ({ id }: { id: string }) => (
  <a href={EXPLORER("address", id)} target="_blank" rel="noreferrer">
    {short(id)}
  </a>
);

const DEPOSIT_REASON: Record<string, string> = {
  BelowMinimum: "Меньше минимального депозита",
  SharesTooSmall: "Слишком мало: за эту сумму вы получите 0 shares",
  InvalidAccounting: "Учёт vault не сходится — контракт откажет",
  ZeroAmount: "Сумма должна быть больше нуля",
};

export default function App() {
  const [wallet, setWallet] = useState<BrowserWallet | null>(null);
  const [vault, setVault] = useState<VaultView | null | undefined>(undefined); // undefined = грузим
  const [user, setUser] = useState<UserView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const walletRef = useRef<BrowserWallet | null>(null);
  walletRef.current = wallet;
  const requestId = useRef(0);
  const userChoseWallet = useRef(false);

  const refresh = useCallback(async () => {
    if (!client) return;
    const id = ++requestId.current;
    const w = walletRef.current;
    // медленный ответ для кошелька A не должен перезаписать данные кошелька B
    const stale = () => id !== requestId.current || walletRef.current !== w;
    try {
      const [v, u] = await Promise.all([client.loadVault(), w ? client.loadUser(w.publicKey) : null]);
      if (stale()) return;
      setVault(v);
      setUser(u);
      setLoadError("");
    } catch (e) {
      if (!stale()) setLoadError(describeError(e));
    }
  }, []);

  useEffect(() => {
    setUser(null);
    setLoadError("");
    refresh();
    const timer = setInterval(refresh, 20_000);
    return () => clearInterval(timer);
  }, [wallet, refresh]);

  // Phantom: тихое подключение, смена аккаунта, отключение из кошелька
  useEffect(() => {
    if (!hasInjectedWallet()) return;
    const usingPhantom = () => walletRef.current?.kind === "injected";
    connectInjected(true)
      .then((w) => !userChoseWallet.current && setWallet(w))
      .catch(() => {});
    const offAccount = onInjectedEvent("accountChanged", () => {
      if (!usingPhantom()) return;
      connectInjected(true)
        .then((w) => usingPhantom() && setWallet(w))
        .catch(() => usingPhantom() && setWallet(null));
    });
    const offDisconnect = onInjectedEvent("disconnect", () => usingPhantom() && setWallet(null));
    return () => {
      offAccount();
      offDisconnect();
    };
  }, []);

  async function connect(kind: "injected" | "dev") {
    userChoseWallet.current = true;
    setStatus(null);
    try {
      setWallet(import.meta.env.DEV && kind === "dev" ? devWallet() : await connectInjected());
    } catch (e) {
      setStatus({ kind: "error", text: describeError(e) });
    }
  }

  async function disconnect() {
    userChoseWallet.current = true;
    await wallet?.disconnect().catch(() => {});
    setWallet(null);
    setStatus(null);
  }

  async function run(okText: string, send: () => Promise<string>): Promise<boolean> {
    setBusy(true);
    setStatus(null);
    try {
      const sig = await send();
      setStatus({ kind: "ok", text: okText, sig });
      return true;
    } catch (e) {
      console.error(e);
      setStatus({ kind: "error", text: describeError(e) });
      return false;
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  if (!CONFIGURED || !client) {
    return (
      <div className="page">
        <h1>CLMM Vault</h1>
        <div className="status error">
          Сайт не настроен: в <code>app/src/vault-config.json</code> нет programId/tokenMint. Админ: задеплойте программу
          в devnet и выполните <code>npm run setup-demo</code> в папке <code>06-clmm-vault</code> (см. README, неделя 14).
        </div>
      </div>
    );
  }

  const dec = vault?.decimals ?? 6; // share_mint: mint::decimals = token_mint.decimals
  const tokenFmt = (raw: bigint) => `${formatAmount(raw, dec)} ${TOKEN_SYMBOL}`;
  const shareFmt = (raw: bigint) => `${formatAmount(raw, dec)} shares`;
  const blocked = vault ? blockedActions(vault) : {};
  const isAdmin = !!(wallet && vault && wallet.publicKey.equals(vault.admin));

  const depositPreview = (a: bigint): Preview => {
    if (!vault) return { ok: false, error: "Загружаем vault…" };
    const q = quoteDeposit(a, vault.totalTokens, vault.totalShares, vault.minDeposit);
    if (!q.ok) {
      const extra = q.reason === "BelowMinimum" ? ` (${tokenFmt(vault.minDeposit)})` : "";
      return { ok: false, error: DEPOSIT_REASON[q.reason] + extra };
    }
    return { ok: true, text: `Комиссия 1%: ${tokenFmt(q.fee)} · в vault: ${tokenFmt(q.net)} · получите ≈ ${shareFmt(q.shares)}` };
  };
  const withdrawPreview = (s: bigint): Preview => {
    if (!vault) return { ok: false, error: "Загружаем vault…" };
    const out = quoteWithdraw(s, vault.totalTokens, vault.totalShares);
    return out === 0n ? { ok: false, error: "Слишком мало: за эти shares вы получите 0" } : { ok: true, text: `Получите ${tokenFmt(out)}` };
  };

  return (
    <div className="page">
      <header>
        <div>
          <h1>CLMM Vault</h1>
          <p className="muted">
            Vault недель 9–13 на Solana <span className="badge">devnet</span>
          </p>
        </div>
        <div className="wallet">
          {wallet ? (
            <>
              <button className="ghost" title="Скопировать адрес" onClick={() => navigator.clipboard?.writeText(wallet.publicKey.toBase58())}>
                {wallet.name}: {short(wallet.publicKey.toBase58())}
              </button>
              <button className="ghost" onClick={disconnect}>
                Отключить
              </button>
            </>
          ) : (
            <>
              <button onClick={() => connect("injected")}>Подключить Phantom</button>
              {import.meta.env.DEV && (
                <button className="ghost" onClick={() => connect("dev")}>
                  Тестовый кошелёк
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {status && (
        <div className={`status ${status.kind}`} role="status">
          {status.text}{" "}
          {status.sig && (
            <a href={EXPLORER("tx", status.sig)} target="_blank" rel="noreferrer">
              Транзакция в Explorer
            </a>
          )}
        </div>
      )}
      {loadError && <div className="status error">Не удалось загрузить данные: {loadError}</div>}

      <section className="card">
        <h2>Vault</h2>
        {vault === undefined && <p className="muted">Загружаем…</p>}
        {vault === null && (
          <p>
            Vault для токена <code>{short(TOKEN_MINT!.toBase58())}</code> ещё не создан. Админ: <code>npm run setup-demo</code>.
          </p>
        )}
        {vault && (
          <>
            <dl className="stats">
              <div>
                <dt>total_tokens</dt>
                <dd>{tokenFmt(vault.totalTokens)}</dd>
              </div>
              <div>
                <dt>total_shares</dt>
                <dd>{shareFmt(vault.totalShares)}</dd>
              </div>
              <div>
                <dt>{vault.inMarket ? "Цена 1 share до выхода в рынок" : "Цена 1 share"}</dt>
                <dd>{tokenFmt(sharePrice(vault.totalTokens, vault.totalShares, dec))}</dd>
              </div>
              <div>
                <dt>Режим</dt>
                <dd>
                  {vault.inMarket ? <span className="warn">В рынке</span> : vault.paused ? <span className="warn">Пауза</span> : "Обычный"}
                </dd>
              </div>
            </dl>
            <p className="muted small">
              Комиссия депозита 1% · минимум {tokenFmt(vault.minDeposit)} · резерв на счёте vault {tokenFmt(vault.reserve)} ·
              supply shares {shareFmt(vault.shareSupply)} · пара Raydium: {vault.pairSet ? "задана" : "нет"} · позиция:{" "}
              {vault.positionOpen ? "открыта" : "нет"}
            </p>
            <p className="muted small">
              Программа <Addr id={PROGRAM_ID!.toBase58()} /> · vault <Addr id={client.addresses.vaultState.toBase58()} /> ·{" "}
              {TOKEN_SYMBOL} <Addr id={TOKEN_MINT!.toBase58()} /> · админ <Addr id={vault.admin.toBase58()} />
            </p>
          </>
        )}
      </section>

      {vault && (
        <section className="card">
          <h2>Мой счёт</h2>
          {!wallet && <p className="muted">Подключите кошелёк, чтобы вносить и выводить токены.</p>}
          {wallet && !user && <p className="muted">Загружаем…</p>}
          {wallet && user && (
            <>
              <dl className="stats">
                <div>
                  <dt>SOL</dt>
                  <dd>{user.sol.toFixed(4)}</dd>
                </div>
                <div>
                  <dt>{TOKEN_SYMBOL} на кошельке</dt>
                  <dd>{tokenFmt(user.tokens)}</dd>
                </div>
                <div>
                  <dt>Мои shares</dt>
                  <dd>{shareFmt(user.shares)}</dd>
                </div>
                <div>
                  <dt>{vault.inMarket ? "Стоили до выхода в рынок" : "Стоят сейчас"}</dt>
                  <dd>{tokenFmt(quoteWithdraw(user.shares, vault.totalTokens, vault.totalShares))}</dd>
                </div>
              </dl>

              {(user.sol < MIN_SOL || user.tokens === 0n) && (
                <p className="note">
                  Нужны тестовые SOL и {TOKEN_SYMBOL}. Попросите админа выполнить в папке 06-clmm-vault:
                  <br />
                  <code>npm run faucet -- {wallet.publicKey.toBase58()}</code>
                </p>
              )}
              {isAdmin && (
                <p className="note">
                  Это кошелёк админа: на его ATA приходит комиссия, поэтому депозит с него контракт отклонит (AliasedAccount).
                  Для сценария пользователя возьмите другой кошелёк.
                </p>
              )}

              {!user.card ? (
                <div className="action">
                  <h3>Шаг 1. Карточка</h3>
                  <p className="hint">
                    {blocked.createCard ??
                      "UserCard — ваш PDA в vault (seeds: user_card, vault, ваш адрес). Без неё нет ни депозита, ни вывода. Рента ≈ 0.0016 SOL, вернётся при закрытии."}
                  </p>
                  <button
                    disabled={busy || user.sol < MIN_SOL || !!blocked.createCard}
                    onClick={() => run("Карточка создана.", () => client.createCard(wallet))}
                  >
                    {busy ? "Ждём подтверждения…" : "Создать карточку"}
                  </button>
                </div>
              ) : (
                <>
                  <p className="muted small">
                    Карточка: внесено (net) {tokenFmt(user.card.deposited)} · shares по карточке {shareFmt(user.card.shares)} · создана{" "}
                    {new Date(user.card.createdAt * 1000).toLocaleString()}
                  </p>
                  <div className="actions" key={wallet.publicKey.toBase58()}>
                    <ActionForm
                      title="Внести"
                      unit={TOKEN_SYMBOL}
                      decimals={dec}
                      max={user.tokens}
                      busy={busy}
                      blockedReason={blocked.deposit}
                      submitLabel="Внести"
                      preview={depositPreview}
                      onSubmit={(a) => run(`Внесено ${tokenFmt(a)}.`, () => client.deposit(wallet, a, vault.feeWallet))}
                    />
                    <ActionForm
                      title="Вывести"
                      unit="shares"
                      decimals={dec}
                      max={user.shares}
                      busy={busy}
                      blockedReason={blocked.withdraw}
                      submitLabel="Вывести"
                      preview={withdrawPreview}
                      onSubmit={(s) =>
                        run(`Выведено ${shareFmt(s)}.`, () =>
                          client.withdraw(wallet, s, quoteWithdraw(s, vault.totalTokens, vault.totalShares))
                        )
                      }
                    />
                  </div>
                  <div className="row-actions">
                    <button
                      className="ghost"
                      disabled={busy || !!blocked.withdraw || user.shares === 0n}
                      title={blocked.withdraw}
                      onClick={() =>
                        run(`Выведено всё: ${tokenFmt(client.previewAll(vault, user))}.`, () =>
                          client.withdrawAll(wallet, client.previewAll(vault, user))
                        )
                      }
                    >
                      Вывести всё (withdraw_all) — {tokenFmt(client.previewAll(vault, user))}
                    </button>
                    {user.card.deposited === 0n && user.card.shares === 0n && user.shares === 0n && (
                      <button className="ghost" disabled={busy} onClick={() => run("Карточка закрыта, рента возвращена.", () => client.closeCard(wallet))}>
                        Закрыть карточку (вернуть ренту)
                      </button>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </section>
      )}

      {isAdmin && vault && (
        <section className="card">
          <h2>Админ</h2>
          <p className="hint">Пауза выключает внесение и новые карточки; вывод остаётся доступным.</p>
          <button disabled={busy} onClick={() => run(vault.paused ? "Пауза снята." : "Vault на паузе.", () => client.setPaused(wallet!, !vault.paused))}>
            {vault.paused ? "Снять паузу" : "Поставить на паузу"}
          </button>
        </section>
      )}

      <footer className="muted small">
        Swap, позицию Raydium и sync_vault админ выполняет скриптами и тестами (недели 12–13); сайт показывает режим и
        блокирует кнопки, пока деньги в рынке.
      </footer>
    </div>
  );
}
