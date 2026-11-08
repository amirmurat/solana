# Week 10 — Withdraw & CPI

Extends Week 9. Matches the teacher's [Week 10 commit cac7593](https://github.com/0xnurda/vault-dev/commit/cac7593f7f61809e0b4f2ce7ad12222a1667854e), published 4 November 2026.

`withdraw(shares_amount, min_tokens_out)` burns the caller's SPL shares and transfers underlying tokens from the vault using its PDA signature. The second argument is a safety extension: reject if the quoted payout is below the caller's minimum.

```
tokens_out = floor(shares_amount * total_tokens / total_shares)
```

The transaction is atomic: if the payout fails after burning, the burn is rolled back. A full redemption takes all remaining tracked underlying units, so rounding leaves no tracked dust. Withdrawals are allowed while deposits are paused. There is no additional withdrawal fee; the 1% fee is charged only on deposit.

The 1% fee, minimum deposit, unique cards, timestamp, and admin pause remain. Redemption requires the caller's own UserCard. Card counters decrease with saturating subtraction; full redemption clears both counters, including residual history after share transfers. SPL balance remains the source of redeemable ownership. A recipient of transferred shares first creates a card.

`withdraw_all(min_tokens_out)` reads and burns the caller's entire share-account balance atomically. After full redemption, `close_user_card` returns the card's rent to its owner; the owner can later recreate it. Closing a card with recorded deposits/shares is rejected.

W9's conservative accounting policy remains: unsolicited underlying transfers are surplus excluded from tracked assets; direct SPL burns outside this instruction cause a supply mismatch and block activity. This is not a production yield vault. Raydium integration and recovery are separate work.

## Reproduce

Rust, Anchor 0.31.1, Solana CLI 2.1.0, Node 22+, npm:

```bash
cd 05-withdrawal-vault
npm ci
mkdir -p target/deploy
solana-keygen new --silent --no-bip39-passphrase --outfile target/deploy/w10_vault-keypair.json
anchor keys sync
anchor build
cargo test --lib
bash scripts/test-local.sh
```

CI generates a disposable program ID and runs actual build, deployment and tests on a local validator. [Implementation verification passed](https://github.com/amirmurat/solana/actions/runs/40202145675): **48 integration tests, 15 Rust tests**, SBF build, localnet deployment and TypeScript typecheck. Public logs are in `evidence/`; see REPORT.md for the tested commit and limits.

Accounts retain W9's 194-byte VaultState and 97-byte UserCard. A separate program identity isolates W8/W9 deployments; no migration or in-place upgrade is performed. Do not use the W9 program keypair for this project.

The suite retains 34 W8/W9 checks and covers zero/excess amounts, slippage, signature/owner/mint/account substitution, burn rollback, withdrawal while paused, transferred shares requiring a card, withdraw_all for three users, zero final reserve/supply, card closure/rent return/recreation and redeposit. Rust tests cover rounding and extreme arithmetic.
