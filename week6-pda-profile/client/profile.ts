import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { W6Profile } from "../target/types/w6_profile";

export function profilePda(program: Program<W6Profile>, owner: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("profile"), owner.toBuffer()], program.programId)[0];
}

export async function checkNetwork(connection: Connection) {
  const url = new URL(connection.rpcEndpoint);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "8899";
  const devnet = url.protocol === "https:" && ["api.devnet.solana.com", "devnet.helius-rpc.com"].includes(url.hostname);
  if (!local && !devnet) throw new Error("Only localhost:8899 or approved Devnet RPC is allowed");
  const genesis = await connection.getGenesisHash();
  if (devnet && genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1") throw new Error("RPC is not Solana Devnet");
  return local ? "localnet" : "devnet";
}

export class ProfileClient {
  constructor(readonly program: Program<W6Profile>, readonly provider: AnchorProvider) {}
  address(owner = this.provider.wallet.publicKey) { return profilePda(this.program, owner); }
  async read(owner = this.provider.wallet.publicKey) {
    await checkNetwork(this.provider.connection);
    return this.program.account.profile.fetch(this.address(owner));
  }
  async initialize(name: string, bio: string) {
    await checkNetwork(this.provider.connection);
    return this.program.methods.initializeProfile(name, bio).accountsStrict({
      profile: this.address(), owner: this.provider.wallet.publicKey, systemProgram: SystemProgram.programId
    }).rpc();
  }
  async update(name: string, bio: string) {
    await checkNetwork(this.provider.connection);
    return this.program.methods.updateProfile(name, bio).accountsStrict({
      profile: this.address(), owner: this.provider.wallet.publicKey
    }).rpc();
  }
}
