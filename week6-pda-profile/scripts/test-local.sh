set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.avm/bin:$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.."
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET="$HOME/.config/solana/w6-local.json"
solana config set --url "$ANCHOR_PROVIDER_URL" >/dev/null
[ "$(solana config get | sed -n 's/^RPC URL: //p' | xargs)" = "$ANCHOR_PROVIDER_URL" ]
if ss -ltn | grep -q ':8899 '; then echo 'RPC port already occupied'; exit 1; fi
mkdir -p "$HOME/.cache/w6"
ledger=$(mktemp -d "$HOME/.cache/w6/ledger.XXXXXX")
solana-test-validator --ledger "$ledger" --quiet > "$HOME/.cache/w6/validator.log" 2>&1 &
validator_pid=$!
trap 'kill "$validator_pid" 2>/dev/null || true; wait "$validator_pid" 2>/dev/null || true' EXIT
ready=0
for attempt in $(seq 1 30); do
 if solana cluster-version --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1; then ready=1; break; fi
 kill -0 "$validator_pid" || { echo 'Validator stopped'; exit 1; }
 sleep 1
done
[ "$ready" = 1 ] || { echo 'Validator RPC unavailable'; exit 1; }
anchor test --skip-build --skip-local-validator --provider.cluster localnet > "$HOME/.cache/w6/test.log" 2>&1
npm run typecheck >> "$HOME/.cache/w6/test.log" 2>&1
printf 'Localnet tests and TypeScript check passed\n'
