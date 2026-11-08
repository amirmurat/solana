# Week 10 — current assignment verification

Teacher reference: [students-vault-card, cac7593](https://github.com/0xnurda/vault-dev/commit/cac7593f7f61809e0b4f2ce7ad12222a1667854e), 4 November 2026.

Implemented: SPL burn followed by PDA-signed underlying transfer; checked u128 proportional payout; min_tokens_out; zero, excess and dust rejection; withdrawals during deposit pause. The caller must have their own UserCard. Card balances decrease with saturating subtraction, matching transferable shares; full redemption clears residual card counters. withdraw_all burns the current share-account balance in one atomic call. After redemption the owner can close the card, receive its rent, and recreate it.

Verified code commit: `6299ed65b4816009d39e69ade03d18e3f36a145c`. [Fresh CI, 8 November 2026](https://github.com/amirmurat/solana/actions/runs/42510079858) SUCCESS: Anchor 0.31.1/Solana 2.1.0 SBF and IDL build, 15 Rust tests, **49 integration tests**, TypeScript typecheck. The program was actually deployed to a local validator. New logs and balance/transaction snapshots are preserved under evidence/current-assignment/. Older evidence in the parent folder describes the earlier implementation and is retained as history.

The suite checks three depositors, full redemption through withdraw_all, zero final reserve/share supply, missing card for transferred shares, burn rollback on frozen destination, account substitutions, slippage, rent refund, and card recreation. The deposit fee remains 1%; there is no second withdrawal fee.

Devnet deployment and Explorer evidence are not completed. Localnet signatures are labelled and must not be presented as Devnet proofs. Main and the original W8/W9 programs were not changed or upgraded. Direct external SPL burns remain unsupported, and unsolicited surplus is not distributed. No Mainnet actions were performed.
