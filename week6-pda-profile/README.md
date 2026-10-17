# W6 — Solana PDA Profile (IT Startup)

Source code from the W6 submission archive for the individual IT Startup practical assignment.

**Stack:** Anchor 0.31.1, Solana 2.1.0, Rust, Node.js 22, TypeScript.

The program creates and updates a wallet-owned on-chain profile using a Program Derived Address (PDA).

- PDA seeds: `[b"profile", owner.publicKey]`.
- Fields: owner, name (maximum 32 UTF-8 bytes), bio (maximum 256 UTF-8 bytes), bump.
- `initialize_profile` creates the profile.
- `update_profile` allows modifications only by the profile owner.
- TypeScript client: `client/profile.ts` and `client/demo.ts`.
- Five test scenarios: create, authorized update, read/PDA, unauthorized update rejection, maximum name length validation.

## Reproduce locally

Requirements: Rust/Solana CLI 2.1, Anchor 0.31.1, Node.js 22, a disposable localnet wallet.

```bash
git clone https://github.com/amirmurat/solana.git
cd solana/week6-pda-profile
npm install
anchor build
# Put a disposable localnet-only keypair at ~/.config/solana/w6-local.json
bash scripts/test-local.sh
```

The test script launches a local validator on port 8899 and invokes `anchor test` and `npm run typecheck`.

**Security:** never commit wallet files, private keys, seed phrases, `.env`, `target/`, `.anchor/`, or `node_modules/`. The default wallet path in `Anchor.toml` has been normalized for publication and can be overridden with `ANCHOR_WALLET`.

**Source note:** The original archive included `Cargo.lock` and `package-lock.json`; these dependency lockfiles are **not included in this GitHub publication**. Running `npm install` generates an npm lockfile. This repository should not be treated as byte-identical to the submitted ZIP. The Rust/TypeScript source code and project manifests were uploaded from the provided archive; machine-specific absolute paths were removed.

**Verification:** `verification.txt` is the submitted local test report (5 passing tests); the tests were **not independently run during this GitHub upload**.

This folder contains only the W6 assignment. Other practice files remain in the repository root and in `03-liquidity-vault/`.
