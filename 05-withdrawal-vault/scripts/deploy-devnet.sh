#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANCHOR_WALLET:?Set ANCHOR_WALLET to your local Devnet keypair file}"
RPC=https://api.devnet.solana.com
[ "$(solana genesis-hash --url "$RPC")" = EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG ]
# Fail if identity and built configuration diverge. Never upgrade the W8 address.
ID=$(solana-keygen pubkey target/deploy/w10_vault-keypair.json)
[ "$ID" != 2VY1E2cQrCA7usG83vShPUNMRqFTWWJKYkHNCiem16jM ]
[ "$ID" != BjiFbMtqS8a5wj37pTNgGkAuNJ7urYjV1SG6WQxF18AX ]
node -e 'const i=require("./target/idl/w10_vault.json"); if(i.address!==process.argv[1])process.exit(1)' "$ID"
solana program deploy --url "$RPC" --keypair "$ANCHOR_WALLET" --program-id target/deploy/w10_vault-keypair.json target/deploy/w10_vault.so
