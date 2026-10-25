#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.avm/bin:$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.."
mkdir -p evidence "$HOME/.cache"
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/w10-local.json}"
if [ ! -f "$ANCHOR_WALLET" ]; then
 mkdir -p "$(dirname "$ANCHOR_WALLET")"
 solana-keygen new --silent --no-bip39-passphrase --outfile "$ANCHOR_WALLET" >/dev/null
 chmod 600 "$ANCHOR_WALLET"
fi
if solana cluster-version --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1; then echo 'Local RPC already occupied'; exit 1; fi
ledger=$(mktemp -d "$HOME/.cache/w10-ledger.XXXXXX")
solana-test-validator --ledger "$ledger"  --quiet > "$HOME/.cache/w10-validator.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
 if solana cluster-version --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1;then break;fi
 kill -0 "$pid" || exit 1
 sleep 1
done
solana airdrop 10 --keypair "$ANCHOR_WALLET" --url "$ANCHOR_PROVIDER_URL" >/dev/null
anchor test --skip-build --skip-local-validator --provider.cluster localnet --provider.wallet "$ANCHOR_WALLET" > evidence/local-tests.txt 2>&1
npm run typecheck >> evidence/local-tests.txt 2>&1
