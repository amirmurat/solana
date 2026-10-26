# Weeks 11–13 Raydium CLMM vault

Extends the tested Week 10 vault in a separate program and directory. Week 8, 9 and 10 source/deployments are preserved. The course guide specifies two own SPL tokens and a CLMM pool (W11), an admin-only vault swap with slippage protection (W12), and a vault-owned liquidity position with fee collection, closure and rebalancing (W13).

## Implementation

- `configure_pool`: validate the official Raydium pool and its two mints, pin its address, create a PDA-owned secondary reserve. Configuration is admin-only and immutable.
- `start_strategy`: lock user deposits and redemptions before exchanging the base token or investing assets.
- `swap_tokens`: exact-input Raydium `swap_v2` CPI, vault PDA signature and nonzero minimum output. The client quotes through RPC and applies a 1% output tolerance.
- `open_clmm_position`: bounded maxima, canonical ticks, Token-2022 position NFT owned by the vault PDA. Temporary bounded delegates are revoked atomically after the CPI.
- `collect_clmm_fees`: Raydium `decrease_liquidity_v2` with zero liquidity, collecting fees without removing principal.
- `close_clmm_position`: remove all liquidity with minima, collect tokens, burn/close the NFT. A second open/close cycle demonstrates rebalancing after the price leaves the first range.
- `settle_strategy`: require no live position and zero secondary-token balance; use the realised base reserve as the new `total_tokens`, then unlock user operations. Profit or loss changes the share price honestly.

This implements the guide's permitted simplification: before redemptions the administrator closes the position and exchanges the second token back. Cash alone is never treated as the value of a live LP position. Deposits are also locked while that value is unsettled, preventing incorrectly priced new shares. W10's general pause behavior remains unchanged outside a strategy cycle.

The original 1% deposit fee, minimum deposit, UserCards and share checks remain. VaultState is now 323 bytes; UserCard remains 97. Use a new program identity; do not upgrade old W8/W9/W10 accounts in place. Ordinary SPL Token mints only for the pair; Token-2022 is used for Raydium's NFT.

## Reproduce

Requirements: Rust, Anchor **0.31.1**, Solana CLI **2.1.0**, Node **22+**, npm.

```bash
cd 06-raydium-vault
npm ci
mkdir -p target/deploy
solana-keygen new --silent --no-bip39-passphrase --outfile target/deploy/raydium_vault-keypair.json
anchor keys sync
anchor build
cargo test --lib
npm run course:local
```

`course:local` downloads the **real official Raydium Devnet executable**, checks its SHA256 snapshot and loads it into a fresh local validator alongside a real AMM config snapshot. It deploys the course vault, runs 48 inherited tests, then runs 16 full Raydium scenarios. The no-op CPI interface crate is never deployed as a fake Raydium executable. If the Devnet binary is upgraded, the hash check intentionally requires a review/update of the snapshot.

The integration creates its own tokens, pool and manual ±10% seed position, then runs a vault cycle with a narrower ±2% position, external swaps, fee collection, forced out-of-range price, closure, ±3% replacement range, swap-back, NAV settlement and final redemption. Ticks round these percentages to the pool's actual tick spacing.

Evidence is written to `evidence/`. The suite deliberately broadcasts one impossible-minimum swap to get a **failed on-chain signature**, rather than presenting an RPC simulation error as a transaction. Localnet signatures are not Devnet Explorer proofs.

For Devnet, use a **user-controlled local keypair**, fund it only with test SOL, build with a fresh program keypair, then:

```bash
export ANCHOR_WALLET=/absolute/path/to/your-devnet-wallet.json
npm run course:devnet
```

This runs only against official Devnet after verifying its genesis hash. The script requires at least 5 test SOL, never selects Mainnet and never uses an earlier W8/W9/W10 program identity. A complete fresh deployment and pool setup may need 5–10 test SOL. Do not rerun a partially completed Devnet scenario blindly; inspect `evidence/` and existing accounts first.

## Validation and limitations

See [REPORT.md](REPORT.md) for observed results and status, [DEFENSE.md](DEFENSE.md) for a Russian explanation and [SOURCE.md](SOURCE.md) for the pinned dependencies and assignment sources. A local passing suite does not satisfy the guide's explicit Devnet transaction deliverables. External SPL share burns and unsolicited reserve donations retain the conservative W10 policy; there is no automatic recovery. Admin strategy management is trusted and can realise losses or delay exits. This is an educational implementation, not an audited production product.
