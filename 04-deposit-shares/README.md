# Week 9 — Deposit & Share Tokens

Amir Murat. Extends the completed Week 8 vault in `../03-liquidity-vault` without modifying it.
Source assignment: [teacher commit 38db796](https://github.com/0xnurda/vault-dev/commit/38db7964441b8b2c62d1d6c9a0457e9434262711).

## Behavior

The owner first creates a UserCard, then calls `deposit(amount)` with a **gross** amount in underlying base units. The instruction transfers `floor(amount / 100)` to the fixed fee token account, transfers the remaining **net** amount to the vault, and issues shares to the depositor. Only the vault PDA can authorize minting. The whole transaction is atomic: a failure also rolls back the fee transfer.

Minimum gross deposit: **one whole underlying token** (`10^mint.decimals`). Both the share mint and underlying mint use the same decimals; the initial rate is one raw share per net base unit. SPL Token Program only, not Token-2022. All arithmetic is integer arithmetic.

```
fee = floor(gross / 100)
net = gross - fee
first deposit: shares = net
later deposits: shares = floor(net * total_shares / total_tokens)
```

The product uses u128; conversion, additions and division are checked. A zero-share result is rejected. `total_tokens` tracks net instruction deposits, not unsolicited token transfers. Donations are surplus and do not change the quoted share price in this deposit-only exercise. External share burns cause `InvalidAccounting` and stop further deposits; recovery and withdrawals are future work. This is an educational deposit contract, not a production vault.

| User  | Gross tokens |  Fee | Net / shares | Share fraction |
| ----- | -----------: | ---: | -----------: | -------------: |
| A     |          100 |    1 |           99 |            4/7 |
| B     |           50 |  0.5 |         49.5 |            2/7 |
| C     |           25 | 0.25 |        24.75 |            1/7 |
| Total |          175 | 1.75 |       173.25 |              1 |

## Accounts and retained W8 features

| Account            | PDA seeds / validation                  | Purpose / size                                                                                 |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| VaultState         | `vault`, underlying mint                | Admin, mint, reserve, share mint, bump, pause, totals, fee destination, minimum; **194 bytes** |
| Reserve            | `vault_tokens`, underlying mint         | SPL account controlled by VaultState                                                           |
| Share mint         | `share_mint`, underlying mint           | SPL mint controlled by VaultState; no freeze authority                                         |
| UserCard           | `user_card`, VaultState, user           | Owner, vault, bump, `created_at`, cumulative net deposited and issued shares; **97 bytes**     |
| User source        | Correct mint, signer owns account       | Pays gross amount                                                                              |
| User share account | Correct share mint, signer owns account | Receives minted shares                                                                         |
| Fee wallet         | Exact stored token-account address      | Initially validated underlying mint and admin ownership                                        |

W8 initialization, unique cards, timestamp, admin-only pause/resume and rent-refunding card closure remain. Pausing blocks both new cards and deposits. Empty cards can close even while paused. A card with deposit history cannot close, because closing/recreating would erase its cumulative record. Card counters describe historical issuance; transferable SPL balances are the current ownership source.

## Compatibility and deployment

W9 uses a separate program identity: `BjiFbMtqS8a5wj37pTNgGkAuNJ7urYjV1SG6WQxF18AX`. This is a configured ID, **not a claim of Devnet deployment**. W8 and main are left intact.

The new fields are appended after the original W8 fields, but old accounts are too short (W8: 138 / 81 bytes). Do not upgrade W8 in place or try to deserialize its accounts with W9. A separate program gives all PDA addresses a new namespace. No automatic migration is provided. New W9 vaults require initialization and cards.

The fee account is fixed per vault and owned by the initializing admin. The provided client creates the admin fee ATA. To deposit as that same admin, use a separate source token account; source equal to fee destination is rejected. Neither source nor fee destination can alias the reserve.

## Reproduce on Linux

Requirements: Rust, Solana CLI **2.1.0**, Anchor CLI **0.31.1**, Node **22+**, npm.

```bash
cd 04-deposit-shares
npm ci
# Private files below are local only and gitignored.
mkdir -p target/deploy
solana-keygen new --silent --no-bip39-passphrase --outfile target/deploy/w9_vault-keypair.json
anchor keys sync                 # fresh local identity; changes only this W9 project
anchor build
cargo test --lib
bash scripts/test-local.sh       # starts isolated validator, deploys .so, runs both suites/typecheck
```

Build commands and test results are recorded in `REPORT.md` and `evidence/`. The pinned Anchor/Solana toolchain emits dependency and syscall warnings; the local validator integration tests verify the resulting binary at runtime.

GitHub Actions `.github/workflows/week9.yml` reproduces build and integration checks using a disposable program key; it never deploys to Devnet/Mainnet and uploads only public logs. Build and integration checks passed for commit `2b91cb6`: [CI result](https://github.com/amirmurat/solana/actions/runs/40197523054).

## Client and tests

`client/vault.ts` provides initialization, card, pause, close and deposit helpers. Network checks permit only localhost:8899 or official Devnet with a verified genesis hash. On-chain programs are inherently cluster-independent; the network guard protects supplied tooling.

`tests/vault.ts` retains the 16 W8 behavior checks with the updated account size. `tests/deposit.ts` covers actual SPL transfers and minting, three users, minimum/zero, fees, pause/resume, missing card, forged accounts, signatures, rollback and burn/donation behavior. Rust unit tests cover quote boundaries and account sizes.

See [REPORT.md](REPORT.md) for observed results and [DEFENSE.md](DEFENSE.md) for explanation and questions. No private keys or seed phrases belong in submissions.

## Optional Devnet verification

After funding a separate Devnet wallet and building with its new program keypair:

```bash
export ANCHOR_WALLET=/absolute/path/to/your-devnet-wallet.json
bash scripts/deploy-devnet.sh
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com npm run devnet
```

The smoke script saves only public results to `evidence/devnet-smoke.json`. Devnet deployment and smoke testing remain pending because the faucet refused the funding request. The deployment script never targets W8 or Mainnet.
