import {Program,AnchorProvider} from "@coral-xyz/anchor";
import {PublicKey,SystemProgram,SYSVAR_RENT_PUBKEY} from "@solana/web3.js";
import {TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {W8Vault} from "../target/types/w8_vault";
export async function checkNetwork(provider:AnchorProvider){
 const u=new URL(provider.connection.rpcEndpoint);
 const local=["127.0.0.1","localhost"].includes(u.hostname)&&u.port==="8899";
 const dev=u.protocol==="https:"&&u.hostname==="api.devnet.solana.com";
 if(!local&&!dev)throw new Error("Only localnet and Devnet permitted");
 const hash=await provider.connection.getGenesisHash();
 if(dev&&hash!=="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")throw new Error("Not Devnet");
 return local?"localnet":"devnet";
}
export function addresses(p:Program<W8Vault>,mint:PublicKey,user:PublicKey){
 const derive=(...s:Buffer[])=>PublicKey.findProgramAddressSync(s,p.programId)[0];
 const vaultState=derive(Buffer.from("vault"),mint.toBuffer());
 return {vaultState,vaultTokenAccount:derive(Buffer.from("vault_tokens"),mint.toBuffer()),shareMint:derive(Buffer.from("share_mint"),mint.toBuffer()),userCard:derive(Buffer.from("user_card"),vaultState.toBuffer(),user.toBuffer())};
}
export async function initialize(p:Program<W8Vault>,provider:AnchorProvider,mint:PublicKey){
 await checkNetwork(provider);const a=addresses(p,mint,provider.wallet.publicKey);
 return p.methods.initializeVault().accountsStrict({vaultState:a.vaultState,vaultTokenAccount:a.vaultTokenAccount,shareMint:a.shareMint,tokenMint:mint,admin:provider.wallet.publicKey,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId,rent:SYSVAR_RENT_PUBKEY}).rpc();
}
export async function createCard(p:Program<W8Vault>,provider:AnchorProvider,mint:PublicKey){
 await checkNetwork(provider);const a=addresses(p,mint,provider.wallet.publicKey);
 return p.methods.createUserCard().accountsStrict({vaultState:a.vaultState,userCard:a.userCard,user:provider.wallet.publicKey,systemProgram:SystemProgram.programId}).rpc();
}
export async function pause(p:Program<W8Vault>,provider:AnchorProvider,mint:PublicKey,value:boolean){
 await checkNetwork(provider);const a=addresses(p,mint,provider.wallet.publicKey);
 return p.methods.setPaused(value).accountsStrict({vaultState:a.vaultState,admin:provider.wallet.publicKey}).rpc();
}
export async function closeCard(p:Program<W8Vault>,provider:AnchorProvider,mint:PublicKey){
 await checkNetwork(provider);const a=addresses(p,mint,provider.wallet.publicKey);
 return p.methods.closeUserCard().accountsStrict({vaultState:a.vaultState,userCard:a.userCard,user:provider.wallet.publicKey}).rpc();
}
