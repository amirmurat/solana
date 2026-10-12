import {AnchorProvider,Program,Wallet} from "@coral-xyz/anchor";
import {PublicKey,Keypair,SystemProgram,Transaction} from "@solana/web3.js";
import {getMint,getAccount} from "@solana/spl-token";
import {writeFileSync,existsSync,readFileSync,mkdirSync} from "node:fs";
import idl from "../target/idl/w8_vault.json";
import {W8Vault} from "../target/types/w8_vault";
import {addresses,checkNetwork,initialize,createCard,pause,closeCard} from "../client/vault";
async function main(){
 const provider=AnchorProvider.env();if(await checkNetwork(provider)!=="devnet")throw new Error("Devnet required");
 const p=new Program<W8Vault>(idl as W8Vault,provider);
 const mint=new PublicKey(process.env.UNDERLYING_MINT||"AVXKppnYRA4MR8dYFcYFigWqwf6n69AsNieCRyJkZKMz");
 const a=addresses(p,mint,provider.wallet.publicKey);
 mkdirSync("evidence",{recursive:true});const path=process.env.EVIDENCE_FILE||"evidence/official-devnet.json";
 const e:any=existsSync(path)?JSON.parse(readFileSync(path,"utf8")):{};
 if(e.programId&&(e.programId!==p.programId.toBase58()||e.admin!==provider.wallet.publicKey.toBase58()||e.underlyingMint!==mint.toBase58()))throw new Error("Evidence belongs to another run; set EVIDENCE_FILE to a new path");
 Object.assign(e,{programId:p.programId.toBase58(),network:"devnet",admin:provider.wallet.publicKey.toBase58(),underlyingMint:mint.toBase58(),accounts:Object.fromEntries(Object.entries(a).map(([k,v])=>[k,v.toBase58()]))});
 const save=()=>writeFileSync(path,JSON.stringify(e,null,2)+"\n");save();
 if(!await p.account.vaultState.fetchNullable(a.vaultState)){e.initializeVault=await initialize(p,provider,mint);save();}
 if(!await p.account.userCard.fetchNullable(a.userCard)){e.createUserCard=await createCard(p,provider,mint);save();}
 let card=await p.account.userCard.fetch(a.userCard);if(!card.owner.equals(provider.wallet.publicKey)||!card.vault.equals(a.vaultState)||card.createdAt.toNumber()<=0)throw new Error("Card invariant failed");
 if(!e.firstCreatedAt)e.firstCreatedAt=card.createdAt.toString();save();
 if(!e.pause){e.pause=await pause(p,provider,mint,true);save();}
 if(!e.pausedCreationRejected){
 const keyPath=process.env.TEST_USER_WALLET;if(!keyPath)throw new Error("Set TEST_USER_WALLET outside repository");
 const user=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath,"utf8"))));
 const otherProvider=new AnchorProvider(provider.connection,new Wallet(user),provider.opts);
 const otherProgram=new Program<W8Vault>(p.idl,otherProvider);
 if(await provider.connection.getBalance(user.publicKey)<10_000_000){e.testUserFunding=await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({fromPubkey:provider.wallet.publicKey,toPubkey:user.publicKey,lamports:10_000_000})));save();}
 let code:string|undefined;try{await createCard(otherProgram,otherProvider,mint);}catch(err){code=(err as any).error?.errorCode?.code;}
 if(code!=="VaultPaused")throw new Error("Paused creation not rejected");
 const blockedCard=addresses(p,mint,user.publicKey).userCard;
 if(await provider.connection.getAccountInfo(blockedCard))throw new Error("Rejected card left an account");
 e.pausedCreationRejected=code;e.rejectedUser=user.publicKey.toBase58();e.rejectedCard=blockedCard.toBase58();save();
}
 if(!e.closeUserCard){const info=await provider.connection.getAccountInfo(a.userCard);e.cardRentLamports=info!.lamports;e.closeUserCard=await closeCard(p,provider,mint);save();}
 if(!e.closeProof){let tx=await provider.connection.getTransaction(e.closeUserCard,{commitment:"confirmed",maxSupportedTransactionVersion:0});for(let i=0;!tx&&i<15;i++){await new Promise(r=>setTimeout(r,500));tx=await provider.connection.getTransaction(e.closeUserCard,{commitment:"confirmed",maxSupportedTransactionVersion:0});}
 if(!tx||tx.meta?.err)throw new Error("Closure proof missing");const userIndex=tx.transaction.message.staticAccountKeys.findIndex(k=>k.equals(provider.wallet.publicKey));const delta=tx.meta!.postBalances[userIndex]-tx.meta!.preBalances[userIndex];if(delta!==e.cardRentLamports-tx.meta!.fee)throw new Error("Rent refund mismatch");if(await provider.connection.getAccountInfo(a.userCard))throw new Error("Card remains after closure");e.closeProof={slot:tx.slot,fee:tx.meta!.fee,ownerBalanceChange:delta,returnedRent:e.cardRentLamports,accountAbsent:true};save();}
 if(!e.resume){e.resume=await pause(p,provider,mint,false);save();}
 if(!await p.account.userCard.fetchNullable(a.userCard)){e.recreateUserCard=await createCard(p,provider,mint);save();}
 const v=await p.account.vaultState.fetch(a.vaultState);card=await p.account.userCard.fetch(a.userCard);const share=await getMint(provider.connection,a.shareMint),vault=await getAccount(provider.connection,a.vaultTokenAccount);
 if(v.paused||!v.admin.equals(provider.wallet.publicKey)||!v.tokenMint.equals(mint)||!v.shareMint.equals(a.shareMint)||!v.vaultTokenAccount.equals(a.vaultTokenAccount)||!share.mintAuthority?.equals(a.vaultState)||share.freezeAuthority!==null||share.supply!==0n||share.decimals!==6||!vault.owner.equals(a.vaultState)||!vault.mint.equals(mint)||vault.amount!==0n||!card.owner.equals(provider.wallet.publicKey)||!card.vault.equals(a.vaultState))throw new Error("Final invariants failed");
 e.verified={paused:false,createdAt:card.createdAt.toString(),shareSupply:"0",tokenVaultBalance:"0",mintAuthority:share.mintAuthority?.toBase58(),tokenAuthority:vault.owner.toBase58(),checkedAt:new Date().toISOString()};
 e.transactions={};for(const name of ["initializeVault","createUserCard","pause","closeUserCard","resume","recreateUserCard"]){if(e[name]){let tx=await provider.connection.getTransaction(e[name],{commitment:"confirmed",maxSupportedTransactionVersion:0});for(let i=0;!tx&&i<15;i++){await new Promise(r=>setTimeout(r,500));tx=await provider.connection.getTransaction(e[name],{commitment:"confirmed",maxSupportedTransactionVersion:0});}if(!tx||tx.meta?.err)throw new Error("Missing transaction proof "+name);e.transactions[name]={signature:e[name],slot:tx.slot,err:tx.meta?.err,explorer:`https://explorer.solana.com/tx/${e[name]}?cluster=devnet`};}}
 save();console.log(JSON.stringify(e,null,2));
}
main().catch(err=>{console.error(err instanceof Error?err.message:"Verification failed");process.exitCode=1;});
