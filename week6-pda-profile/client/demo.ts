import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { W6Profile } from "../target/types/w6_profile";
import idl from "../target/idl/w6_profile.json";
import { ProfileClient, checkNetwork } from "./profile";

async function main() {
  const provider = AnchorProvider.env();
  console.log("Network:", await checkNetwork(provider.connection));
  const program = new Program<W6Profile>(idl as W6Profile, provider);
  const client = new ProfileClient(program, provider);
  const existing = await program.account.profile.fetchNullable(client.address());
  if (!existing) await client.initialize("Student", "W6 PDA profile");
  await client.update("Student", "Updated through TypeScript");
  const profile = await client.read();
  console.log({ address: client.address().toBase58(), owner: profile.owner.toBase58(), name: profile.name, bio: profile.bio });
}
main().catch(() => { console.error("Client failed; check network, validator and program deployment"); process.exitCode = 1; });
