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

## Weeks 11–13 (assignments published later)

| Week | Teacher commit | Implementation |
|---|---|---|
| 11 — AMM and concentrated liquidity | [fe2adcf](https://github.com/0xnurda/vault-dev/commit/fe2adcf7385866e6f585e69e719979ba423640ec), 11 Nov 2026 | `06-clmm-vault/scripts/create-clmm-pool.ts` |
| 12 — swap through Raydium | [26ac3a6](https://github.com/0xnurda/vault-dev/commit/26ac3a68d9b7a049fdf206af19b4f83a06820c13), 20 Nov 2026 | `06-clmm-vault`: `add_pair_token`, `swap`, `sync_vault`, extra task 7 |
| 13 — position in a CLMM pool | same | `06-clmm-vault`: `open_position`, `increase_liquidity`, `collect_fees`, `close_position`, extra tasks 8–9 |

The accounting concern below is handled as in the teacher's design: any swap or open position sets `in_market`, which blocks deposits and withdrawals; `sync_vault` re-prices shares from the real TOKEN_A balance only when TOKEN_B is zero and no position is open. See [06-clmm-vault/README.md](06-clmm-vault/README.md).

The earlier `weeks11-13-raydium` branch (25 Oct 2026) predates these assignments and is kept as history.

Original note (25 Oct 2026): a safe integration also needs to account for vault assets deployed into liquidity: liquid reserve balance is no longer the whole backing of shares. Do not simply copy open/close CPI into the deposit/withdraw program while continuing to price shares from liquid reserve alone. Pool/account/mint relationships and NFT position ownership need validation and real integration tests.
