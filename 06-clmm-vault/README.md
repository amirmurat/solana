# Weeks 11–13 — Raydium CLMM vault

Extends the Week 10 vault (`05-withdrawal-vault`: cards, 1% deposit fee, minimum deposit, `withdraw` / `withdraw_all`, card rent refund). Follows the teacher's assignments:

| Week | Teacher commit | Here |
|---|---|---|
| 11 — AMM and concentrated liquidity | [fe2adcf](https://github.com/0xnurda/vault-dev/commit/fe2adcf7385866e6f585e69e719979ba423640ec) | `scripts/create-clmm-pool.ts` |
| 12 — swap through Raydium | [26ac3a6](https://github.com/0xnurda/vault-dev/commit/26ac3a68d9b7a049fdf206af19b4f83a06820c13) | `add_pair_token`, `swap`, `sync_vault` in `src/raydium.rs` + extra task 7 |

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
