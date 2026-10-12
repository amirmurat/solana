# Source and changes

Starter: https://github.com/0xnurda/vault-dev/tree/students-vault-card
Verified source commit: d21d974827f7dbdb9c4a186eaf5e1e1860a01ff9

The official initialize_vault/create_user_card structure and PDA seeds are retained. Project module name and Program ID are specific to this deployment.

Assignment changes:
- UserCard.created_at: Clock::get()?.unix_timestamp; account space increased by 8 bytes.
- close_user_card: canonical vault/card constraints, owner signature, close=user refund; closure remains allowed while paused.
- VaultState.paused: false on initialization; set_paused is restricted to the configured admin; card creation checks VaultPaused before account allocation.

Additional verification: 16 integration tests, reproducible Linux validator script, TypeScript client, Devnet transaction evidence and bytecode comparison.

Only ordinary SPL Token Program mints are accepted. Deposits, withdrawals and Raydium are outside the Week 8 assignment.
