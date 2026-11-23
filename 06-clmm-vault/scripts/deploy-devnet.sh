#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANCHOR_WALLET:?Set ANCHOR_WALLET to your local Devnet keypair file}"
RPC=https://api.devnet.solana.com
[ "$(solana genesis-hash --url "$RPC")" = EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG ]
# Fail if identity and built configuration diverge. Never upgrade the W8, W9 or W10 addresses.
ID=$(solana-keygen pubkey target/deploy/clmm_vault-keypair.json)
[ "$ID" != 2VY1E2cQrCA7usG83vShPUNMRqFTWWJKYkHNCiem16jM ]
[ "$ID" != BjiFbMtqS8a5wj37pTNgGkAuNJ7urYjV1SG6WQxF18AX ]
[ "$ID" != F4owJE4EFYLhcBnbPLHrwsuKLuLFFDnyYKAgARaJZaAx ] # never upgrade the W10 program
node -e 'const i=require("./target/idl/clmm_vault.json"); if(i.address!==process.argv[1])process.exit(1)' "$ID"
solana program deploy --url "$RPC" --keypair "$ANCHOR_WALLET" --program-id target/deploy/clmm_vault-keypair.json target/deploy/clmm_vault.so
