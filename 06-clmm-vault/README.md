# Weeks 11–13 — Raydium CLMM vault

Extends the Week 10 vault (`05-withdrawal-vault`: cards, 1% deposit fee, minimum deposit, `withdraw` / `withdraw_all`, card rent refund). Follows the teacher's assignments:

| Week | Teacher commit | Here |
|---|---|---|
| 11 — AMM and concentrated liquidity | [fe2adcf](https://github.com/0xnurda/vault-dev/commit/fe2adcf7385866e6f585e69e719979ba423640ec) | `scripts/create-clmm-pool.ts` |

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
