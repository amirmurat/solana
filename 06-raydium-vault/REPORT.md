# Weeks 11–13 technical report

**Date:** 26 October 2026. **Project:** `06-raydium-vault`, branch `weeks11-13-raydium`.

The implementation covers the original guide's W11 own tokens/pool/manual position, W12 vault CPI swaps with slippage, and W13 vault-owned NFT position, fee collection, closure and out-of-range rebalancing. W8–W10 and main remain unchanged; the project uses a separate program identity.

## Observed verification

Fresh local execution: **48/48 inherited integration tests**, **16/16 real Raydium scenarios**, **15/15 Rust tests**, successful SBF/IDL build and TypeScript typecheck. The test launcher downloads the real official Devnet CLMM executable, checks its SHA256 and loads it on a local validator with an actual AMM config snapshot. It never deploys the CPI interface crate as a no-op mock.

The first CI run built successfully and passed the 48 inherited tests, but two Raydium assertions read state too early (unchanged price / NFT account not found). Consistent `confirmed` transaction completion and reads replaced the mixed commitment levels. The repeated local suite passed fully. Both fresh CI runs for commit `dbf04baabef2d68cb74f419efce1b5a8f9790ba9` passed: [PR run 40284278956](https://github.com/amirmurat/solana/actions/runs/40284278956) and [push run 40284272511](https://github.com/amirmurat/solana/actions/runs/40284272511). Each completed the SBF/IDL build, 15 Rust tests, 48 inherited tests, 16 Raydium scenarios and TypeScript checks. Public logs and independently generated snapshots from the PR run are preserved under `evidence/ci/`; these are separate from the fresh Work local run. The first failed run remains [40282590775](https://github.com/amirmurat/solana/actions/runs/40282590775). Later evidence/documentation commits do not change program or client logic.

## Measured local scenario

Both course tokens have 6 decimals. W11 seeds a manual position around the initial price 1, rounded by tick spacing to approximately 0.8976324433–1.0941693603. The vault's first range is narrower, approximately 0.9762868812–1.0181620601. The client uses explicit liquidity-based maxima, leaving a cash buffer.

| Observation | Actual result |
|---|---:|
| Gross user deposit | 1,000 base tokens |
| Deposit fee | 10 base tokens |
| Initial accounted NAV / shares | 990 / 990 |
| Swap input | 400 base tokens |
| Quoted output | 398.929963 secondary tokens |
| Minimum output | 394.940663 secondary tokens |
| Pool price before / after swap | 1 / 0.9996489695126828 |
| Explicitly collected fees | 0.055709 base + 0.027854 secondary |
| Forced out-of-range tick / old upper tick | 203 / 180 |
| Realised base NAV after closure, rebalance and swap-back | 976.510670 |
| Final base, secondary and share supply after redemption | 0 / 0 / 0 |

The forced-price experiment realises a loss of **13.489330 base tokens** against the 990 initially invested. Collected fees are not net profit. Settlement records the actual returned base assets, so shares correctly absorb the loss rather than overstating balances.

The slippage test deliberately broadcasts a failing transaction and records its signature. Its observed Raydium error is **6018, TooLittleOutputReceived**; source, destination and vault accounting stay unchanged. Local signatures and snapshots are in `evidence/weeks12-13-localnet.json`; they are not Devnet Explorer proofs.

## Accounts, authority and accounting

VaultState grows from W10's 194 to **323 bytes**; UserCard remains **97 bytes**. All earlier fields are retained, with pool, secondary mint/reserve, position mint and strategy lock appended. A fresh program/PDA namespace avoids incompatible in-place upgrades.

Pool configuration is admin-only and pins an immutable official pool with the expected mint pair. Both token reserves belong to the vault PDA. Swaps sign as that PDA. Raydium's open-position payer is temporarily approved for bounded token amounts inside one atomic instruction; the delegates are revoked before it returns. The position NFT belongs to the vault PDA. Closing/collection verifies the pool, NFT, personal position and tick-array relationships.

User deposits and redemptions are blocked during a strategy cycle. Settlement requires no live position, zero secondary balance and a positive realised base balance. Only then does it update total_tokens and unlock operations. The guide explicitly permits this manual-close/swap-back approach; it avoids using liquid cash as the value of invested LP assets.

## Limits and delivery status

**Devnet is not completed.** The guide requires live Devnet tokens, pool/position addresses, swap success/failure Explorer links, fee/closure results and redemption evidence. Local/CI execution does not substitute for these deliverables. Earlier faucet funding attempts failed. The Devnet launcher uses only the official endpoint and checks its genesis; it requires a user-controlled local keypair with test SOL. No private key should be sent through chat. No Mainnet action was performed.

The conservative W10 policy remains: direct SPL share burns can block activity; unsolicited reserve donations are not generally priced as deposits and can prevent a strategy start until accounting matches. No automatic recovery is provided. Admin strategy management is trusted and can delay exits. Mint freeze authority, price movement and token-program risks remain. This is an educational implementation and source/runtime review, not a professional security audit or production vault.

## SDK compatibility notes

A new empty pool has no tick cache, so its initial position uses the SDK createPool result. In SDK 0.2.70-alpha the convenience liquidity helper's amount result is unsuitable for the derived liquidity; token maxima are recalculated explicitly for that liquidity. Own pool keys come from RPC rather than the hosted pool index. Real runtime tests cover these paths. The first unsuccessful CI and the confirmation fix are retained in Git history and linked from the PR.
