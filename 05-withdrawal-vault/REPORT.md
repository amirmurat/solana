# W10 validation report

Implementation: withdrawal via SPL burn and PDA-authorized transfer, checked u128 quote, min_tokens_out, withdrawal while deposits are paused, transferable-share ownership, zero/dust/excess protections.

Reference: teacher's `main` commit 57eab487680d0b322e214d827b55054b58b9bda7. The exercise shown there includes three depositors followed by all withdrawals and an empty vault.

Current verification: CI build/integration results pending. No W10 Devnet deployment has been performed. Do not reuse W9's passed results as proof of W10. The workflow `.github/workflows/week10.yml` builds and deploys to an actual local validator, runs Rust and TypeScript tests, and uploads public logs.

Expected three-user result after gross deposits 100, 50, 25: 173.25 underlying backs 173.25 shares; fee account holds 1.75. Redemption empties tracked vault assets and share supply. Test also transfers 1 share from A to a fourth wallet before redemption; its owner can redeem without a card. This changes the final distribution by a gift of 1 underlying token, not the total conservation result.

Limitations: deposits/withdrawals do not implement external-burn recovery or donation distribution. Share ownership is SPL token balance; card history is not redeemable ownership. Raydium/AMM/CLMM requirements for W11–W13 are not declared completed by this project.
