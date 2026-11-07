/**
 * Queries the Argos mirror of the EF ERC-7730 registry on Arkiv (Rabdi), trusting only the
 * Argos writer wallet. Read-only; needs no private key (keyless, or ARKIV_ACCESS_KEY if set).
 *
 *   node --env-file-if-exists=.env scripts/query-mirror.ts stale
 *       descriptors whose auditor attestation no longer matches their content
 *   node --env-file-if-exists=.env scripts/query-mirror.ts deployments <chainId> <0xaddress>
 *       registry descriptors bound to one contract, with proxy kind and monitoring flag
 *   node --env-file-if-exists=.env scripts/query-mirror.ts protocol <entity_dir>
 *       every descriptor file of one registry folder (e.g. aave, safe, 1inch)
 *   node --env-file-if-exists=.env scripts/query-mirror.ts proxies <chainId> <proxy_kind>
 *       deployments on one chain by upgrade mechanism (eip1967, beacon, diamond, safe, none)
 *   node --env-file-if-exists=.env scripts/query-mirror.ts kind <calldata|eip712|include>
 *       descriptors by type
 *
 * Every command prints the Arkiv query it ran before its results, so the filter is checkable
 * rather than implied. `proxies` and `kind` exist because they are the two questions the mirror is
 * most useful for and the only ones that previously had no runnable form.
 */
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, eq } from "@arkiv-network/sdk/query";
import { addr, u64 } from "@arkiv-network/sdk/schema";
import { http } from "viem";
import { DeploymentSchema, DescriptorSchema, TRUSTED_CREATORS } from "@driftguard/core";

const EXPLORER = "https://rabdi.explorer.arkiv.network";
const pub = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });
const [cmd, a1, a2] = process.argv.slice(2);

function usage(): never {
  console.error(
    "usage: query-mirror.ts stale | deployments <chainId> <0xaddress> | protocol <entity_dir>" +
      " | proxies <chainId> <proxy_kind> | kind <calldata|eip712|include>",
  );
  process.exit(2);
}

/** Reads every page, so a count is a count and not "the first 100". */
async function fetchAll<T>(page: (offset: number) => Promise<{ entities: readonly T[]; skipped: number }>): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; ) {
    const r = await page(offset);
    out.push(...r.entities);
    const covered = r.entities.length + r.skipped;
    if (covered < 100) return out;
    offset += covered;
  }
}

const descSelect = { $key: true, registry_path: true, descriptor_hash: true, registry_commit: true, attestation: true, kind: true } as const;

if (cmd === "stale") {
  console.log(`dg_descriptor WHERE attestation = "stale" CREATED BY ${TRUSTED_CREATORS.writer}`);
  const r = await pub.select(descSelect).from(DescriptorSchema).where(eq("attestation", "stale")).createdBy(TRUSTED_CREATORS.writer).limit(100).fetch();
  for (const e of r.entities) console.log(`${e.registry_path.value}  hash ${e.descriptor_hash.value}  @${e.registry_commit.value.slice(0, 7)}  ${EXPLORER}/entity/${e.$key}`);
  console.log(`${r.entities.length} row(s)`);
} else if (cmd === "deployments") {
  if (!a1 || !a2 || !/^0x[0-9a-fA-F]{40}$/.test(a2)) usage();
  console.log(`dg_deployment WHERE chain_id = ${a1} AND address = ${a2.toLowerCase()} CREATED BY ${TRUSTED_CREATORS.writer}`);
  const deps = await pub
    .select({ $key: true, descriptor_hash: true, proxy_kind: true, monitored: true, registry_commit: true })
    .from(DeploymentSchema)
    .where(and(eq("chain_id", u64(BigInt(a1))), eq("address", addr(a2 as `0x${string}`))))
    .createdBy(TRUSTED_CREATORS.writer)
    .limit(100)
    .fetch();
  for (const d of deps.entities) {
    const desc = await pub.select(descSelect).from(DescriptorSchema).where(eq("descriptor_hash", d.descriptor_hash.value)).createdBy(TRUSTED_CREATORS.writer).limit(5).fetch();
    const paths = desc.entities.map((x) => `${x.registry_path.value} (${x.kind.value}, attestation ${x.attestation.value})`).join("; ") || "(descriptor row not found)";
    console.log(`proxy_kind ${d.proxy_kind.value}  monitored ${d.monitored.value}  → ${paths}  ${EXPLORER}/entity/${d.$key}`);
  }
  console.log(`${deps.entities.length} deployment row(s)`);
} else if (cmd === "protocol") {
  if (!a1) usage();
  console.log(`dg_descriptor WHERE entity_dir = "${a1}" CREATED BY ${TRUSTED_CREATORS.writer}`);
  const r = await pub.select(descSelect).from(DescriptorSchema).where(eq("entity_dir", a1)).createdBy(TRUSTED_CREATORS.writer).limit(100).fetch();
  for (const e of r.entities) console.log(`${e.registry_path.value}  ${e.kind.value}  attestation ${e.attestation.value}`);
  console.log(`${r.entities.length} row(s)${r.entities.length === 100 ? " (first page)" : ""}`);
} else if (cmd === "proxies") {
  const KINDS = ["eip1967", "beacon", "diamond", "safe", "none", "no-code", "unknown", "unchecked"];
  if (!a1 || !a2 || !KINDS.includes(a2)) usage();
  console.log(`dg_deployment WHERE chain_id = ${a1} AND proxy_kind = "${a2}" CREATED BY ${TRUSTED_CREATORS.writer}`);
  const rows = await fetchAll((offset) =>
    pub
      .select({ $key: true, address: true, descriptor_hash: true, monitored: true })
      .from(DeploymentSchema)
      .where(and(eq("chain_id", u64(BigInt(a1))), eq("proxy_kind", a2)))
      .createdBy(TRUSTED_CREATORS.writer)
      .limit(100)
      .offset(offset)
      .fetch(),
  );
  for (const d of rows) console.log(`${d.address.value}  monitored ${d.monitored.value}  descriptor ${d.descriptor_hash.value.slice(0, 18)}…`);
  console.log(`${rows.length} deployment row(s) with proxy_kind "${a2}" on chain ${a1}; ${rows.filter((d) => d.monitored.value).length} monitored by Argos`);
} else if (cmd === "kind") {
  if (!a1 || !["calldata", "eip712", "include"].includes(a1)) usage();
  console.log(`dg_descriptor WHERE kind = "${a1}" CREATED BY ${TRUSTED_CREATORS.writer}`);
  const rows = await fetchAll((offset) =>
    pub.select(descSelect).from(DescriptorSchema).where(eq("kind", a1)).createdBy(TRUSTED_CREATORS.writer).limit(100).offset(offset).fetch(),
  );
  for (const e of rows) console.log(`${e.registry_path.value}  attestation ${e.attestation.value}`);
  console.log(`${rows.length} descriptor row(s) of kind "${a1}"`);
} else usage();
