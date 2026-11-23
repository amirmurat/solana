#!/usr/bin/env bash
# Local validator with the REAL Raydium CLMM program dumped from Devnet + Devnet AMM config #0.
# Runs: week 11 pool script, inherited W8-W10 tests, Raydium tests (weeks 12-13), typecheck.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.avm/bin:$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.."
mkdir -p evidence "$HOME/.cache"
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/course-local.json}"
CLMM=DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH
if [ ! -f "$ANCHOR_WALLET" ]; then
 mkdir -p "$(dirname "$ANCHOR_WALLET")"
 solana-keygen new --silent --no-bip39-passphrase --outfile "$ANCHOR_WALLET" >/dev/null
 chmod 600 "$ANCHOR_WALLET"
fi
if solana cluster-version --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1; then echo 'Local RPC already occupied'; exit 1; fi
binary=$(mktemp "$HOME/.cache/raydium-clmm.XXXXXX.so")
solana program dump --url https://api.devnet.solana.com "$CLMM" "$binary" > evidence/raydium-download.txt 2>&1
sha256sum "$binary" | cut -d' ' -f1 >> evidence/raydium-download.txt
ledger=$(mktemp -d "$HOME/.cache/clmm-ledger.XXXXXX")
solana-test-validator --ledger "$ledger" \
  --bpf-program "$CLMM" "$binary" \
  --account CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu fixtures/devnet-clmm-config.json \
  --quiet > "$HOME/.cache/clmm-validator.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
 if solana cluster-version --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1; then break; fi
 kill -0 "$pid" || exit 1
 sleep 1
done
solana airdrop 100 --keypair "$ANCHOR_WALLET" --url "$ANCHOR_PROVIDER_URL" >/dev/null
status=0
# Week 11: own tokens + own CLMM pool (same script that is run on Devnet)
npm run create-pool > evidence/week11-create-pool.txt 2>&1 || status=1
cp pool-localnet.json evidence/ 2>/dev/null || true
# Deploy + all mocha suites (inherited W8-W10 + Raydium weeks 12-13)
anchor test --skip-build --skip-local-validator --provider.cluster localnet --provider.wallet "$ANCHOR_WALLET" > evidence/local-tests.txt 2>&1 || status=1
npm run typecheck > evidence/typecheck.txt 2>&1 || status=1
tail -n 60 evidence/local-tests.txt
exit $status
