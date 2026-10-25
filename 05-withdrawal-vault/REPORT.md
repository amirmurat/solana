# W10 validation report

Implementation: withdrawal via SPL burn and PDA-authorized transfer, checked u128 quote, min_tokens_out, withdrawal while deposits are paused, transferable-share ownership, zero/dust/excess protections.

Reference: teacher's `main` commit 57eab487680d0b322e214d827b55054b58b9bda7. The exercise shown there includes three depositors followed by all withdrawals and an empty vault.

Verified implementation commit: `51c27bb55299940d0583ffba5b46002b2194e4bf`.

[GitHub Actions run 40202145675](https://github.com/amirmurat/solana/actions/runs/40202145675) completed successfully on 25 October 2026. Confirmed: Anchor/SBF build and IDL generation, actual localnet deployment, **48 passing integration tests**, **15 passing Rust tests**, and TypeScript typecheck. Public logs and transaction/balance snapshots are committed in `evidence/`.

The run generates a disposable program keypair and syncs the source ID before building. The tested localnet Program ID is recorded in `evidence/three-users-withdraw.json`; it is not a Devnet deployment. Artifact digest: `sha256:b8ba0230b2d8bab9bc28dd3778a68ad81a418eae1fc2b44740d0185506c5bdd2`.

No W10 Devnet deployment has been performed. The final documentation/evidence update does not change the withdrawal implementation; it also corrects a W9→W10 label in the optional Devnet script.

Expected three-user result after gross deposits 100, 50, 25: 173.25 underlying backs 173.25 shares; fee account holds 1.75. Redemption empties tracked vault assets and share supply. Test also transfers 1 share from A to a fourth wallet before redemption; its owner can redeem without a card. This changes the final distribution by a gift of 1 underlying token, not the total conservation result.

Limitations: deposits/withdrawals do not implement external-burn recovery or donation distribution. Share ownership is SPL token balance; card history is not redeemable ownership. Raydium/AMM/CLMM requirements for W11–W13 are not declared completed by this project.
