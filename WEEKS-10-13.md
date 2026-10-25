# Published material: Weeks 10–13

Checked on 25 October 2026.

| Source | Confirmed content | Week mapping |
|---|---|---|
| Teacher `students-vault-card` branch, commit `38db796` | W8 cards and W9 deposits/shares | Explicit W9 label |
| Teacher `main`, commit `57eab487` | SPL withdrawal; Raydium CLMM open/close via CPI; position script | README/code do not assign these features to each of W10–W13 |
| Course requirements summary | W10 withdraw/CPI; W11–W13 Raydium/AMM/CLMM | Summary only; original W8–W15 guide is needed for precise deliverables |

References:
- https://github.com/0xnurda/vault-dev/tree/students-vault-card
- https://github.com/0xnurda/vault-dev/tree/57eab487680d0b322e214d827b55054b58b9bda7

`05-withdrawal-vault` extends W9 with withdrawal and the teacher README's three-user full-redemption exercise. The original W8 and W9 projects are preserved.

Weeks 11–13 are not claimed completed. Before integrating Raydium, confirm the original weekly exercise text, required AMM/CLMM operations, target Devnet pool/token pair, slippage bounds, position lifecycle and required demonstration/evidence. The teacher's existing main is a reference, not proof of each week's individual completion.

A safe integration also needs to account for vault assets deployed into liquidity: liquid reserve balance is no longer the whole backing of shares. Do not simply copy open/close CPI into the deposit/withdraw program while continuing to price shares from liquid reserve alone. Pool/account/mint relationships and NFT position ownership need validation and real integration tests.
