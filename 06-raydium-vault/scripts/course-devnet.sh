#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANCHOR_WALLET:?Set ANCHOR_WALLET to a private local Devnet keypair file}"
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
[ "$(solana genesis-hash --url "$ANCHOR_PROVIDER_URL")" = EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG ]
node - <<'JS'
const fs=require('fs'),{Connection,Keypair}=require('@solana/web3.js');
(async()=>{const p=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET,'utf8'))));const c=new Connection(process.env.ANCHOR_PROVIDER_URL,'confirmed');if(await c.getBalance(p.publicKey)<5e9)throw Error('Fund your Devnet wallet with at least 5 test SOL before deployment. No Mainnet funds.');})().catch(e=>{console.error(e.message);process.exitCode=1});
JS
bash scripts/deploy-devnet.sh
npm run raydium:test > evidence/raydium-devnet-tests.txt 2>&1
