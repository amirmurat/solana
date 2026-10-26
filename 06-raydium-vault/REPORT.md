# Weeks 11–13 validation report

This checkpoint restores the W11–W13 implementation and its reproducible verification workflow. Current revision is awaiting a new CI run. Earlier local execution in the development session passed 48 inherited and 16 Raydium scenarios, but those temporary log files were not retained; the new CI artifact will be the independently inspectable evidence for this revision.

Implemented scope follows the original W8–W15 guide: W11 own tokens/pool/manual position, W12 vault CPI swap with successful and failed slippage transactions, W13 vault-owned NFT position, nonzero fees, closure and out-of-range rebalancing. The guide explicitly requires Devnet evidence. **Devnet completion is not claimed.** Previous faucet requests failed; no keys or secret phrases are published.

The integration is against the real Raydium executable from Devnet, pinned by SHA256 in `fixtures/raydium-program.json`. The AMM configuration snapshot has 117 bytes and is owned by the official Devnet CLMM program. CPI client revision is pinned separately; its stub instruction bodies are not a test implementation.

Safety checks include admin authorization, immutable pool and mint pairing, PDA token authorities, actual NFT ownership, mint/position/pool relationships, bounded atomic delegate approval/revocation, nonzero swap minimum, position deposit maxima, close minima, and locked user accounting while strategy assets are not fully back in the base token. Final settlement uses real returned tokens, including realised losses.

SDK compatibility fixes: a new empty pool has no tick cache, so the initial manual position uses the SDK createPool result. SDK 0.2.70-alpha's convenience liquidity helper is used only for its liquidity result; token maxima are recalculated for that actual liquidity. Own pool keys come from RPC instead of a hosted pool index/API. Runtime tests verify these paths.
