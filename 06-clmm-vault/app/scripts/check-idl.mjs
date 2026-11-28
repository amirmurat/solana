// CI: app/src/idl/clmm_vault.json — вручную выписанное подмножество IDL (только то, что вызывает сайт).
// Сверяем его с настоящим IDL из `anchor build`: дискриминаторы, порядок и флаги аккаунтов,
// аргументы, поля структур и ошибки. Любое расхождение — exit 1.
import fs from "node:fs";

const full = JSON.parse(fs.readFileSync(process.argv[2] ?? "../target/idl/clmm_vault.json", "utf8"));
const sub = JSON.parse(fs.readFileSync(new URL("../src/idl/clmm_vault.json", import.meta.url), "utf8"));
const problems = [];
const same = (what, a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${what}\n  subset: ${JSON.stringify(a)}\n  anchor: ${JSON.stringify(b)}`);
};
const byName = (list, name) => list.find((x) => x.name === name);
const accFlags = (a) => ({ name: a.name, writable: !!a.writable, signer: !!a.signer, address: a.address ?? null });

for (const ix of sub.instructions) {
  const real = byName(full.instructions, ix.name);
  if (!real) { problems.push(`instruction ${ix.name} missing in anchor IDL`); continue; }
  same(`${ix.name}.discriminator`, ix.discriminator, real.discriminator);
  same(`${ix.name}.accounts`, ix.accounts.map(accFlags), real.accounts.map(accFlags));
  same(`${ix.name}.args`, ix.args, real.args);
}
for (const acc of sub.accounts) same(`account ${acc.name}`, acc.discriminator, byName(full.accounts, acc.name)?.discriminator);
for (const t of sub.types) same(`type ${t.name}`, t.type, byName(full.types, t.name)?.type);
same("errors", sub.errors, full.errors);

if (problems.length) {
  console.error(`IDL subset differs from anchor build (${problems.length}):\n` + problems.join("\n"));
  process.exit(1);
}
console.log(`IDL subset OK: ${sub.instructions.length} instructions, ${sub.accounts.length} accounts, ${sub.errors.length} errors match target/idl`);
