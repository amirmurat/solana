# Weeks 10–13 course coverage

Original guide supplied 25 October 2026 resolves the weekly mapping:

| Week | Required result | Implementation |
|---|---|---|
| 10 | Share burn, PDA-authorized redemption; Devnet CPI explanation | `05-withdrawal-vault`, isolated W10 branch |
| 11 | Two own SPL tokens, own CLMM pool, manual seed position | `06-raydium-vault/scripts/clmm.ts` |
| 12 | Admin-only vault swap, slippage, success/failure signatures, price change | `strategy::swap`, client and integration scenario |
| 13 | Vault-owned NFT position, fee collection, closure, out-of-range rebalance | `strategy::open/manage`, client and integration scenario |

Code and automated verification are distinct from Devnet submission evidence. The guide explicitly requires Devnet. The new project isolates W8/W9/W10 source and deployments; main is not changed. Refer to `06-raydium-vault/REPORT.md` for actual validation and remaining work.
