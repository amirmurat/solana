# Week 8 Vault and User Card

**Murat Amir Olzhasuly · SE · English Department**

Completed assignment from the instructor's [students-vault-card branch](https://github.com/0xnurda/vault-dev/tree/students-vault-card). The starter provides initialize_vault and create_user_card. This submission adds all three exercises: blockchain creation time, owner-only card closure with rent refund, and admin-controlled pause of new cards.

## Verified result

- Anchor 0.31.1 SBF build and IDL generation: passed.
- 16 local-validator integration tests: passed.
- TypeScript type checking: passed.
- Final program update and six successful Devnet instruction calls: confirmed by RPC with no transaction errors.
- Creating a new card while paused: rejected with VaultPaused; no card account remains.
- Card closure while paused: account removed; owner received 1,061,720 lamports of rent. As fee payer, the owner's net balance increase was 1,056,720 after the 5,000-lamport fee.
- Resume and recreation: confirmed. Final paused=false, share supply=0 and vault token balance=0.
- Downloaded Devnet bytecode matches the local executable; unused ProgramData allocation contains only zero padding. SHA-256 and lengths are in evidence/binary-verification.json.

## Architecture

```text
underlying SPL mint
  VaultState PDA [vault, token_mint]
    vault token account PDA [vault_tokens, token_mint]
    share mint PDA [share_mint, token_mint]
    UserCard PDA [user_card, vault_state, user]
```

| Account | Solana program owner | Role |
|---|---|---|
| VaultState | This program | admin, token mint, token vault, share mint, bump, paused; 138 bytes |
| Vault token account | SPL Token Program | Holds underlying tokens; token authority is VaultState PDA |
| Share mint | SPL Token Program | 6 decimals; mint authority is VaultState PDA; supply starts at zero; no freeze authority |
| UserCard | This program | vault, owner, bump, created_at; 81 bytes |

The Solana owner of an SPL account is the Token Program. The separate authority stored inside that account is the vault PDA. A PDA has no private key; this program can authorize future CPI operations using its canonical seeds. Admin cannot mint shares directly. Upgrade authority can update the program, so PDA authority does not make the code immutable.

## Assignment changes

1. **created_at:** Clock::get()?.unix_timestamp records chain time. UserCard space increased by 8 bytes.
2. **close_user_card:** validates canonical vault and card PDA, card-vault link and owner signature. close=user returns rent to the owner. Closing remains permitted while paused; no user's rent is locked by the pause.
3. **paused:** initializes to false. set_paused requires the configured admin's signature. A paused vault rejects card creation atomically; any attempted allocation rolls back.

The official instruction names are retained. initialize_vault corresponds to the methodology's create_vault; create_user_card corresponds to its user-position opening. Raydium open_position in the instructor's main branch is a later-week operation and is outside this assignment.

## Reproduce on localnet

Environment verified: Ubuntu 24.04 / WSL2, Rust stable 1.99.0, Solana 2.1.0, AVM/Anchor 0.31.1, Node.js 22.23.3. Keep Cargo.lock and package-lock.json. Release size optimization reduces rent costs.

```bash
cd 03-liquidity-vault
npm ci
anchor build
# Fresh clone: generate/sync your LOCAL Program ID; published Devnet evidence keeps its original ID.
anchor keys sync
anchor build
bash scripts/test-local.sh
```

The script creates an independent local-only wallet outside the repository, starts a fresh Linux ledger, funds it with 10 local SOL, deploys to localhost:8899, runs all tests and type checking, then stops its validator. It never deploys to Devnet. Logs are written to evidence/local-tests.txt. Existing wallet files are never overwritten.

## Integration tests

1. Official vault links, owners, PDA mint authority, zero supply/balance.
2. User card owner/vault and blockchain timestamp; correct 81-byte space.
3. Distinct cards for two users.
4. Duplicate vault rejection.
5. Duplicate card rejection.
6. Forged PDA rejection; no account remains.
7. Missing owner signature rejection.
8. Non-admin pause rejected; state unchanged.
9. Admin pause succeeds.
10. Paused creation rejected; account allocation rolls back.
11. Closing another user's card rejected; original card preserved.
12. Owner closure while paused; exact rent refund minus transaction fee; account removed.
13. Closing an already closed card rejected.
14. Admin resumes; closed card can be recreated; third user can create a card.
15. Wrong-vault card closure rejected.
16. Administrator cannot directly mint shares; supply remains zero.

These tests execute transactions against a validator. They do not merely check strings in the source.

## Devnet reproduction

Keys are not part of this repository. For a new deployment, generate your own external program key and sync the Program ID. Use a separate Devnet wallet with test SOL. The client checks the Devnet genesis hash before actions; Mainnet is rejected.

```bash
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=/absolute/path/outside-repository/devnet-wallet.json
export TEST_USER_WALLET=/absolute/path/outside-repository/second-devnet-wallet.json
export EVIDENCE_FILE=evidence/my-devnet-run.json
# Optional: use another ordinary SPL mint instead of the existing practice mint.
export UNDERLYING_MINT=AVXKppnYRA4MR8dYFcYFigWqwf6n69AsNieCRyJkZKMz
npm run devnet
```

Deploy your built program before running the client. The script saves signatures immediately, skips completed creation steps, checks pause rejection using a different user, closes and recreates the owner card, and verifies all transaction metadata and final account invariants. It stops when an evidence file belongs to a different program, wallet or mint. If needed, it funds the second test user with 0.01 Devnet SOL once; no real SOL is used.

## Explorer and evidence

- [Program](https://explorer.solana.com/address/2VY1E2cQrCA7usG83vShPUNMRqFTWWJKYkHNCiem16jM?cluster=devnet)
- [vaultState](https://explorer.solana.com/address/5q7rBzggEMADJE17bKxPgxz6yeu393cjcLDkJYWGAhVn?cluster=devnet)
- [vaultTokenAccount](https://explorer.solana.com/address/Fbmt4F9XYUaZgaXJ1XawJuMFRrTnL3usV67nCbNML1ZD?cluster=devnet)
- [shareMint](https://explorer.solana.com/address/8zKWGF7HRwjebJtcs6NSsbzPXwBH2VF3HuH39caDApEV?cluster=devnet)
- [userCard](https://explorer.solana.com/address/J1xWXKpgPB8oRoDWj5XNUmEjnamntZQNtUHsAt6dgo87?cluster=devnet)
- [initializeVault](https://explorer.solana.com/tx/yuKAB6k6uNACJDsZzce7ovCXs7JtLdzzkmT2bDUzoqoqGbFBMm78XKEW76MvHMtKnnsmvTG2ntFXigHTwXZMRUk?cluster=devnet)
- [createUserCard](https://explorer.solana.com/tx/371DsvKQG5HYnZpPd1LM3NtujzdKSUtmhau9QeJuSdezxHWZrQCZnqLwTvQ4rha66yd36eNFK4g7Ct4pAKWqpBEz?cluster=devnet)
- [pause](https://explorer.solana.com/tx/2chcDFVgNkYEFEFV87FvQpFxxXFe7sAz4qwRmov8ZBHxBKGkANPb6WjrHDnrGp5XZ5RP2BLXJdJM6cG7ZZY8qkMc?cluster=devnet)
- [closeUserCard](https://explorer.solana.com/tx/31gUG1Xi6pyAJZFKYs1b5XHwj68LqLYR7afXV92AcQe88RMycKfpnM3F4Gh8MVcCzdCXJDpGmGGCko6yMBM9X3ej?cluster=devnet)
- [resume](https://explorer.solana.com/tx/CB8w5UVBzBsbjNs6naxwRAa42UJD8TZwabzfVFjSvPrGRRKwF4k5M8ohoowEFf5q9SgWSMw8BAvz8zuUFL6oo1q?cluster=devnet)
- [recreateUserCard](https://explorer.solana.com/tx/3LUUURHpqqPNfcu7JP2CkwPPzENgNjgBS44SmdeHHHTFgnsUExrwJ8VSeeBKdVDA8x96pXNNNzs3bkN9cLFvanYt?cluster=devnet)


- official-devnet.json: signatures, slots, decoded state checks, pause rejection and exact closure proof.
- accounts-rpc.json: raw public RPC snapshot of final accounts and absent rejected card.
- deployment.json: successful update signature.
- binary-verification.json: hash, lengths and equality of deployed executable bytes.
- local-tests.txt, build.txt, typecheck.txt: actual command results.
- idl/w8_vault.json: generated public IDL.

## Scope and defense

Deposit, withdrawal, swaps and Raydium are not implemented. Earlier token practice and W1–W6 are preserved. SOURCE.md identifies the exact instructor commit and assignment changes. DEFENSE.md explains the code and likely defense questions in plain Russian. The English report is in reports/.
