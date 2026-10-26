#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.."
mkdir -p evidence "$HOME/.cache"
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/course-local.json}"
if [ ! -f "$ANCHOR_WALLET" ]; then
 mkdir -p "$(dirname "$ANCHOR_WALLET")"
 solana-keygen new --silent --no-bip39-passphrase --outfile "$ANCHOR_WALLET" >/dev/null
 chmod 600 "$ANCHOR_WALLET"
fi
if solana cluster-version --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1; then echo 'Local RPC already occupied'; exit 1; fi
binary=$(mktemp "$HOME/.cache/raydium-clmm.XXXXXX.so")
solana program dump --url https://api.devnet.solana.com DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH "$binary" > evidence/raydium-download.txt 2>&1
node - "$binary" <<'JS'
const fs=require('fs'),crypto=require('crypto');const expected=require('./fixtures/raydium-program.json');const actual=crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex');
if(actual!==expected.sha256)throw Error('Official Devnet program changed. Review the upgrade and update the verified snapshot; do not substitute the CPI stub.');
JS
ledger=$(mktemp -d "$HOME/.cache/raydium-ledger.XXXXXX")
solana-test-validator --ledger "$ledger" --bpf-program DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH "$binary" --account CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu fixtures/devnet-clmm-config.json --quiet > "$HOME/.cache/raydium-validator.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT
for i in $(seq 1 60);do
 if solana cluster-version --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1;then break;fi
 kill -0 "$pid"
 sleep 1
done
solana airdrop 100 --keypair "$ANCHOR_WALLET" --url "$ANCHOR_PROVIDER_URL" >/dev/null
anchor test --skip-build --skip-local-validator --provider.cluster localnet --provider.wallet "$ANCHOR_WALLET" > evidence/inherited-tests.txt 2>&1
COURSE_FRESH_POOL=1 npm run raydium:test > evidence/raydium-tests.txt 2>&1
npm run typecheck > evidence/typecheck.txt 2>&1
