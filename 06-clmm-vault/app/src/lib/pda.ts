// Адреса PDA — те же seeds, что в lib.rs / raydium.rs.
import { PublicKey } from "@solana/web3.js";

const derive = (programId: PublicKey, ...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];

/** ["vault", token_mint] */
export const vaultPda = (programId: PublicKey, mint: PublicKey) => derive(programId, Buffer.from("vault"), mint.toBuffer());
/** ["vault_tokens", token_mint] */
export const vaultTokensPda = (programId: PublicKey, mint: PublicKey) =>
  derive(programId, Buffer.from("vault_tokens"), mint.toBuffer());
/** ["share_mint", token_mint] */
export const shareMintPda = (programId: PublicKey, mint: PublicKey) =>
  derive(programId, Buffer.from("share_mint"), mint.toBuffer());
/** ["user_card", vault_state, user] — порядок важен: vault, потом user */
export const cardPda = (programId: PublicKey, vault: PublicKey, user: PublicKey) =>
  derive(programId, Buffer.from("user_card"), vault.toBuffer(), user.toBuffer());

export function vaultAddresses(programId: PublicKey, mint: PublicKey) {
  const vaultState = vaultPda(programId, mint);
  return {
    vaultState,
    vaultTokenAccount: vaultTokensPda(programId, mint),
    shareMint: shareMintPda(programId, mint),
    card: (user: PublicKey) => cardPda(programId, vaultState, user),
  };
}
