# Weeks 11–13 — Raydium CLMM vault

Extends the Week 10 vault (`05-withdrawal-vault`: cards, 1% deposit fee, minimum deposit, `withdraw` / `withdraw_all`, card rent refund). Follows the teacher's assignments:

| Week | Teacher commit | Here |
|---|---|---|
| 11 — AMM and concentrated liquidity | [fe2adcf](https://github.com/0xnurda/vault-dev/commit/fe2adcf7385866e6f585e69e719979ba423640ec) | `scripts/create-clmm-pool.ts` |
| 12 — swap through Raydium | [26ac3a6](https://github.com/0xnurda/vault-dev/commit/26ac3a68d9b7a049fdf206af19b4f83a06820c13) | `add_pair_token`, `swap`, `sync_vault` in `src/raydium.rs` + extra task 7 |
| 13 — position in a CLMM pool | [26ac3a6](https://github.com/0xnurda/vault-dev/commit/26ac3a68d9b7a049fdf206af19b4f83a06820c13) | `open_position`, `collect_fees`, `close_position` + extra tasks 8 (`increase_liquidity`) and 9 (fee counter) |

The program was copied from Week 10 under a new name (`clmm_vault`) and a new program identity. The W8/W9/W10 programs are never upgraded (`scripts/deploy-devnet.sh` refuses their addresses).

## Week 11 — own tokens and own CLMM pool

- **AMM**: two tokens sit in one pool and the price comes from a formula; swaps trade against the pool, no order book.
- **Concentrated liquidity (CLMM)**: a liquidity provider picks a **price range** instead of 0…∞. The money works only while the price is inside the range, but earns more fees there.
- This week only creates the pool; the contract is unchanged.

`scripts/create-clmm-pool.ts`:

1. Creates two SPL tokens (`TOKEN_A`, `TOKEN_B`, 6 decimals) and mints 1 000 000 of each to the wallet.
2. Reads Raydium AMM config #0 **from the chain** (tick spacing 60, trade fee 0.25%) — the same config the teacher's script gets from the Raydium API.
3. Creates the `TOKEN_A / TOKEN_B` pool in the Raydium CLMM program at price 1 and checks that the pool account is owned by `DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH` (Raydium CLMM on Devnet).
4. Saves the addresses to `pool-<cluster>.json`.

Only `localhost:8899` and the official Devnet RPC (genesis hash checked) are accepted.

### Devnet run (submission)

Needs ~1 SOL on Devnet.

```bash
cd 06-clmm-vault
npm install
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json npm run create-pool
git add pool-devnet.json && git commit -m "Week 11: Devnet CLMM pool"
```

Submit the commit link and the `poolId` from `pool-devnet.json` with its Explorer link (`explorer` field).

### Localnet / CI

`scripts/test-local.sh` starts a validator with the real Raydium CLMM binary dumped from Devnet (`solana program dump`) and AMM config #0 (`fixtures/devnet-clmm-config.json`), then runs the same pool script, the inherited W8–W10 suites and the TypeScript typecheck. The workflow `.github/workflows/weeks11-13.yml` does this on every push and uploads `evidence/` and the generated `package-lock.json`.

```bash
npm install
mkdir -p target/deploy
solana-keygen new --silent --no-bip39-passphrase --outfile target/deploy/clmm_vault-keypair.json
anchor keys sync
anchor build
cargo test --lib
bash scripts/test-local.sh
```

## Week 12 — the vault swaps through Raydium

### Main idea: vault funds "go to the market"

Until now all vault funds were TOKEN_A and `total_tokens` equalled the tracked reserve. Now the admin can swap part of TOKEN_A into TOKEN_B. Meanwhile the TOKEN_A value of the vault is unknown, so shares cannot be priced fairly:

1. `swap` sets `in_market = true`. `deposit` and `withdraw` (and `withdraw_all`) then fail with `InMarket`.
2. When everything is back in TOKEN_A, the admin calls `sync_vault` — best in **one transaction** with `swap(u64::MAX, min_out, a_to_b = false)`. It checks TOKEN_B = 0, takes `total_tokens` from the **real** TOKEN_A balance and lifts the pause.
3. Profit or loss (swap fee 0.25%, slippage) is shared by all holders: shares stay the same, `total_tokens` changes.
4. If no shares are outstanding at sync time, `total_tokens` stays 0: the leftover is untracked surplus (the W9 policy), so the next depositor starts 1:1 instead of hitting `InvalidAccounting`.

All Raydium instructions are admin-only (`Unauthorized`).

| Instruction | What it does |
|---|---|
| `add_pair_token` | Once: vault token account for TOKEN_B, seeds `["vault_tokens_b", token_mint]`, owner = vault PDA. A second call fails (`init`). |
| `swap(amount_in, min_amount_out, a_to_b)` | CPI `swap_v2`; the vault PDA pays and signs. `min_amount_out` — slippage protection (`TooLittleOutputReceived`). `u64::MAX` = whole balance read on-chain, so dust sent right before the swap cannot block `sync_vault`. Pool must be the vault pair, pool vaults must match the direction (`WrongPool`). Tick arrays go in `remaining_accounts` (from `PoolUtils.computeAmountOutFormat`). |
| `sync_vault` | Requires TOKEN_B = 0 (`TokenBNotZero`), sets `total_tokens` from the real balance, `in_market = false`. |

**Extra task 7** — one A → B swap may sell at most 50% of the vault's TOKEN_A (`max_swap_a = balance / 2`, error `SwapTooLarge`; also applies to `u64::MAX`). B → A is not limited, otherwise the vault could not return to TOKEN_A.

`VaultState` grows from 194 to 259 bytes (`token_mint_b`, `vault_token_account_b`, `in_market`).

### Tests (`tests/raydium.ts`)

Every run creates its own tokens, an A/B pool with wallet liquidity (price range 0.5–2) and an empty A/C pool. A user deposits 1000 TOKEN_A (990 after the 1% fee).

- `add_pair_token`: non-admin, success, second call
- `swap`: non-admin, foreign pool A/C, swapped pool vaults, **> 50% (`SwapTooLarge`)**, `min_amount_out` too high, 300 A → B
- `deposit` / `withdraw` blocked with `InMarket`; `sync_vault` with TOKEN_B left, by non-admin
- swap all B → A + `sync_vault` in one transaction after someone sent 1 unit of B; `total_tokens` = real balance
- user withdraws all shares and receives all TOKEN_A; B → A swap with no shares keeps surplus untracked; deposits work again

On Devnet (deploy the program first, ~4 SOL for a ~500 KB program):

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json npm run test:raydium
```

## Week 13 — vault position with concentrated liquidity

| Instruction | What it does |
|---|---|
| `open_position(tick_lower, tick_upper, tick_array_lower_start, tick_array_upper_start, amount_0_max, amount_1_max, base_0)` | Puts vault TOKEN_A/TOKEN_B into `[tick_lower, tick_upper]` (CPI `open_position_with_token22_nft`). Raydium computes liquidity from `amount_0_max` (`base_0`) or `amount_1_max`. Amounts are in **pool** order (token_0 = smaller mint address); the program works out which vault token is token_0. **The position NFT belongs to the vault PDA**; the admin pays rent. Raydium pulls tokens from the payer, so the program `approve`s the admin for at most `amount_*_max` on the vault accounts and `revoke`s right after. One position at a time (`PositionAlreadyOpen`). Sets `in_market`. |
| `increase_liquidity(amount_0_max, amount_1_max, base_0)` | **Extra task 8.** CPI `increase_liquidity_v2` into the open position. Here Raydium pulls tokens from the NFT owner — the vault PDA, which signs — so no approval is needed. |
| `collect_fees` | CPI `decrease_liquidity_v2` with liquidity 0: Raydium sends only the fees; liquidity stays. |
| `close_position(amount_0_min, amount_1_min)` | Collects fees first, then withdraws all liquidity (mins protect the liquidity part, pool order) and closes the position. Raydium returns the rent to the vault PDA (NFT owner); the program moves every lamport above the `VaultState` minimum to the admin who paid it. |
| `sync_vault` | Now also requires no open position (`PositionOpen`). |

`collect_fees`/`close_position`/`increase_liquidity` accept only the vault's own position: `position_nft_mint` must equal `vault_state.position_nft_mint` and `personal_position` must belong to that NFT and pool (`NoOpenPosition`, `WrongPool`).

**Extra task 9** — `VaultState.total_fees_a` / `total_fees_b`: every fee collection (in `collect_fees` and the fee step of `close_position`) measures how much TOKEN_A/TOKEN_B arrived and adds it. Because `close_position` collects fees separately before removing liquidity, the counter never mixes fees with returned principal.

`VaultState` grows to 307 bytes (`position_nft_mint`, `total_fees_a`, `total_fees_b`).

### Full scenario (`tests/raydium.ts`)

```
1. admin: own TOKEN_A / TOKEN_B, CLMM pool (price 1), wallet liquidity
2. admin: initialize_vault(TOKEN_A), add_pair_token(TOKEN_B)
3. user:  create_user_card, deposit 1000 A (990 after fee)
4. admin: swap 300 A → B                       → in_market, deposit/withdraw paused
5. admin: open_position (price 0.8 – 1.25), increase_liquidity (+50 token_0)
6. wallet trades in the pool                   → the vault position earns fees
7. admin: collect_fees (counter = received fees), close_position (rent → admin)
8. admin: swap(all B → A) + sync_vault         → one transaction; total_tokens = real A balance
9. user:  withdraw all shares                  → receives all TOKEN_A of the vault
```

A second vault (on TOKEN_B, pair TOKEN_A) checks that a single-token position opened without any swap also sets `in_market`, that `sync_vault` with an open position fails with `PositionOpen`, and that closing a position with no fees works.

### Limits of this course version

- Devnet only: `raydium-clmm-cpi` is built with the `devnet` feature; the CLMM program address is hard-wired.
- The pool is not pinned to the vault: the admin may use any pool of the TOKEN_A / TOKEN_B pair. The admin is fully trusted (swap price, range, timing).
- Pool rewards are not collected; with rewards enabled `close_position` fails in Raydium. One position at a time.
- While `in_market`, users cannot exit; the admin must close the position and swap back.
- Swaps cost 0.25%; a run can end with `total_tokens` below the deposits if the position earned less than the swap fees.

## Errors

| Error | Cause | Fix |
|---|---|---|
| `InMarket` on deposit / withdraw | funds in TOKEN_B or a position | admin: `close_position`, swap B → A, `sync_vault` |
| `PositionOpen` on `sync_vault` | position still open | `close_position` first |
| `TokenBNotZero` on `sync_vault` | TOKEN_B left on the vault | `swap(u64::MAX, …, false)` + `sync_vault` in one transaction |
| `SwapTooLarge` | A → B over 50% of TOKEN_A | swap in smaller parts |
| `WrongPool` | other pair or swapped pool vaults | check `poolState`, `inputVault` / `outputVault` |
| `NoOpenPosition` | wrong NFT / `personal_position`, or no position | use the vault's own position |
| `PositionAlreadyOpen` | a position is already open | `close_position` first |
| `InvalidTickRange` | `tick_lower >= tick_upper` | swap the bounds |
| `Unauthorized` | Raydium instruction signed by a non-admin | sign with the vault admin |
| `TooLittleOutputReceived` | swap gave less than `min_amount_out` | lower `min_amount_out` or the amount |
| `account data too small` on deploy | the program grew (~500 KB) | `solana program extend <PROGRAM_ID> 100000 --url devnet` |

---

## Неделя 14 — web-интерфейс (MVP)

Эталон преподавателя: [0xnurda/vault-dev@0da0a3b](https://github.com/0xnurda/vault-dev/commit/0da0a3b26edc331a4eac35c67b0dd76151c63940) («web UI for vault, demo setup and faucet scripts»). **Контракт на этой неделе не меняется** — сайт работает с программой `clmm_vault` недель 11–13 из этой папки.

### Что умеет сайт (`app/`, Vite + React + TypeScript)

1. **Подключает Phantom** (`window.phantom.solana`, без wallet-adapter); в `yarn dev` есть ещё «Тестовый кошелёк» (ключ в localStorage, в `yarn build` этот код не попадает).
2. **Показывает vault:** `total_tokens`, `total_shares`, цена 1 share, режим (Обычный / Пауза / В рынке), минимум депозита, реальный резерв, supply shares, пара Raydium и позиция, ссылки Explorer на программу, vault, TOKEN_A и админа.
3. **Создаёт UserCard** — PDA `["user_card", vault, user]`, одна кнопка.
4. **Deposit** с превью по формуле `quote()` из `lib.rs`: комиссия 1% (floor) → fee_wallet, net → vault, shares от net. Сумму меньше минимума (1 целый токен) форма не отправляет.
5. **Withdraw** (ввод shares) и **Вывести всё** (`withdraw_all`). `min_tokens_out` = ровно показанное превью: если состояние vault изменилось между превью и подписью, контракт отклонит с `SlippageExceeded`, а не отдаст меньше.
6. **Закрыть карточку** после полного выхода — рента возвращается владельцу.
7. **Балансы:** SOL, TOKEN_A, shares, их стоимость, данные карточки (net deposited, shares, created_at).
8. **Блокировки как в контракте** (`lib/guards.ts`): `in_market` — выключены deposit и withdraw; `paused` — выключены deposit и создание карточки, вывод работает. Для админа — кнопка паузы.
9. **Понятные ошибки** (`lib/errors.ts`): все пользовательские `VaultError` (`BelowMinimum`, `VaultPaused`, `InMarket`, `SlippageExceeded`, `AliasedAccount`, …), отмена в кошельке, нет SOL, лимит RPC, неподтверждённая транзакция («могла пройти — не повторяйте вслепую»).

Swap, позицию Raydium и `sync_vault` админ по-прежнему делает скриптами и тестами недель 12–13.

### Как сайт говорит с контрактом

```
браузер ── Phantom подписывает ──► транзакция ──► devnet RPC ──► clmm_vault
   ▲                                                                │
   └──────── чтение VaultState / UserCard / балансов ◄──────────────┘
```

| Файл | Что делает |
|---|---|
| `app/src/idl/clmm_vault.json` | Подмножество IDL: 7 инструкций, которые вызывает сайт и setup-demo, `VaultState`, `UserCard`, все 24 ошибки. CI сверяет его с настоящим `target/idl` (`app/scripts/check-idl.mjs`). |
| `app/src/lib/pda.ts` | Seeds из `lib.rs`: `vault`, `vault_tokens`, `share_mint` от mint; `user_card` от (vault, user). |
| `app/src/lib/client.ts` | `makeClient(connection, programId, mint)`: чтение и действия `createCard`, `deposit`, `withdraw`, `withdrawAll`, `closeCard`, `setPaused`. Без `import.meta` — тот же код гоняет devnet-сценарий. ATA для shares / TOKEN_A создаётся в той же транзакции. |
| `app/src/lib/math.ts` | `quoteDeposit` / `quoteWithdraw` — формулы контракта (bigint, вниз). |
| `app/src/lib/amount.ts` | «1.5» ↔ `1500000`, только bigint, проверка ≤ u64::MAX. |
| `app/src/lib/balance.ts` | Баланс ATA; 0 — только если аккаунта нет, ошибки RPC не маскируются. |
| `app/src/lib/guards.ts`, `errors.ts`, `wallet.ts` | Блокировки кнопок, тексты ошибок, Phantom / тестовый кошелёк. |
| `app/src/config.ts` + `vault-config.json` | RPC, `programId`, `tokenMint` — пишет `npm run setup-demo`. Пустой конфиг → сайт честно пишет «не настроен». |

### Запуск локально

**1. Админ: программа и демо-vault в devnet** (из `06-clmm-vault`, кошелёк админа с ~5 devnet SOL):

```bash
npm install
mkdir -p target/deploy && solana-keygen new --no-bip39-passphrase -o target/deploy/clmm_vault-keypair.json
anchor keys sync && anchor build
ANCHOR_WALLET=~/.config/solana/id.json bash scripts/deploy-devnet.sh   # новая identity; W8/W9/W10 адреса скрипт не трогает
ANCHOR_WALLET=~/.config/solana/id.json npm run setup-demo              # TOKEN_A + initialize_vault → app/src/vault-config.json
```

Или без локального тулчейна: GitHub Actions → **Week 14 Devnet deploy + UI scenario** → *Run workflow*. Он использует тот же throwaway-секрет `DEVNET_CI_KEYPAIR`, что и пул недели 11, деплоит, создаёт демо-vault, проходит сценарий и коммитит `app/src/vault-config.json` и `evidence/week14-*` в ветку.

**2. Тестовые токены пользователю:**

```bash
npm run faucet -- <адрес Phantom>        # 1000 TOKEN_A и 0.02 SOL, если у него < 0.01 SOL
npm run faucet -- <адрес Phantom> 50     # другая сумма
```

Печатать TOKEN_A может только тот, кто запускал `setup-demo` (mint authority). Оба скрипта сначала сверяют genesis hash devnet (`scripts/w14-devnet.ts`) и не работают с mainnet. Сам SOL для админа — https://faucet.solana.com (нужен вход через GitHub).

**3. Сайт:**

```bash
cd app
yarn install
yarn dev          # http://localhost:5173
yarn test         # формулы, суммы, PDA, ошибки, блокировки — без сети
yarn build        # tsc + vite build → app/dist
```

Phantom: Settings → Developer Settings → **Testnet Mode**, сеть **Solana Devnet**. Если devnet RPC отвечает 429 — свой RPC в `app/.env.local`: `VITE_RPC_URL=https://…` (файл в `.gitignore`, но значение попадает в собранный JS).

**Важно:** не используйте кошелёк админа как пользователя: комиссия идёт на ATA админа, и депозит с неё контракт отклоняет (`AliasedAccount`) — сайт это объясняет.

### Сценарий проверки

| Шаг | Действие | Ожидание |
|---|---|---|
| 1 | Подключить Phantom (devnet) | Адрес в шапке, подсказка `npm run faucet -- <адрес>` |
| 2 | Админ: `npm run faucet -- <адрес>` | Через ≤ 20 с: 1000 TOKEN_A, 0.02 SOL |
| 3 | «Создать карточку» | «Карточка создана», ссылка Explorer |
| 4 | Ввести `0.5` в «Внести» | «Меньше минимального депозита (1 TOKEN_A)», кнопка выключена |
| 5 | Внести `100` | Превью «Комиссия 1 · в vault 99 · ≈ 99 shares» (на свежем vault); после — shares 99 |
| 6 | Вывести `40` shares | «Получите 40 TOKEN_A»; shares 59 |
| 7 | «Вывести всё» | shares 0, карточка обнулена, появляется «Закрыть карточку» |
| 8 | «Закрыть карточку» | Карточки нет, рента вернулась |
| 9 | Админ: «Поставить на паузу» | У пользователя «Внести» выключено с объяснением, «Вывести» работает |

Автоматическая версия того же сценария на devnet (подписывает Keypair, не Phantom): `DEVNET_ADMIN_KEYPAIR=~/.config/solana/id.json yarn e2e:devnet` → `evidence/week14-devnet-e2e.json` с подписями и ссылками Explorer. Дополнительно проверяет реальные отказы контракта: `BelowMinimum`, `VaultPaused` (и вывод на паузе), `SlippageExceeded`.

### Адрес программы на devnet

Появится в `app/src/vault-config.json` и `evidence/week14-devnet-deploy.txt` после первого запуска workflow / `setup-demo`. **На момент коммита этой ветки программа W14 в devnet не задеплоена** — см. PR.

### Отличия от эталона преподавателя

| Эталон (`simple_vault`) | Здесь (`clmm_vault`) | Почему |
|---|---|---|
| `deposit(amount)` без комиссии; превью `amount·S/T` | Комиссия 1% в `fee_wallet` (аккаунт из `VaultState`), минимум, превью показывает fee/net/shares | Так устроен наш контракт с W9 |
| «shares есть, токенов 0» → 1:1 | → `InvalidAccounting` (форма не отправляет) | Так требует `quote()` в `lib.rs` |
| `withdraw(shares)` | `withdraw(shares, min_tokens_out)`, `withdraw_all(min_tokens_out)`, `close_user_card` | Наши инструкции W10 |
| Только `in_market` | `in_market` + `paused` (deposit и card закрыты, вывод открыт), кнопка паузы для админа | Пауза W9 |
| IDL и типы — полная копия из `target/` | Подмножество IDL + сверка в CI | Сборку app нельзя было запустить без `anchor build` в этой среде; сверка гарантирует совпадение дискриминаторов |
| `PROGRAM_ID` из IDL | Из `vault-config.json` | В `lib.rs` недель 11–13 зашит адрес W10 (`F4ow…`), devnet-деплой W14 получает новую identity |
| PDA-тест на аккаунтах devnet демо-vault | На аккаунте, созданном W10-контрактом в CI localnet (те же seeds) | Своего devnet vault на момент коммита ещё нет |
| `yarn setup-demo` / `yarn faucet` в корне | `npm run setup-demo` / `npm run faucet --` в `06-clmm-vault` (npm, как остальная папка) | Структура репозитория |

### Ограничения MVP

- Только devnet и один vault (из `vault-config.json`). Кнопок swap / позиции / `sync_vault` нет.
- Данные обновляются после действия и раз в 20 с.
- Пока vault в рынке, цена share — до выхода в рынок: `total_tokens` обновляется только на `sync_vault`.
