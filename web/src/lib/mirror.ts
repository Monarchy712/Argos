/**
 * The ERC-7730 registry mirror on Arkiv (dg_descriptor + dg_deployment, written by the importer
 * with our writer key). The Check screen takes descriptor metadata (path, commit, file hash,
 * ERC-8176 hash) from here, then fetches the file and checks its bytes against that hash.
 *
 * Privacy: by default the whole mirror is read in bulk (paged, contract-independent, cached for
 * the session), so the Arkiv node learns "someone loaded the mirror", not which contract. If the
 * keyless budget refuses the bulk read, `lookupContract` falls back to a query for one contract,
 * and the UI says so (the Arkiv node then sees which contract was looked up).
 */
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, eq } from "@arkiv-network/sdk/query";
import { addr, u64 } from "@arkiv-network/sdk/schema";
import { DeploymentSchema, DescriptorSchema, TRUSTED_CREATORS } from "@driftguard/core";
import { http } from "viem";
import type { RegistryManifest } from "./descriptors.ts";

const client = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http(undefined, { retryCount: 0, timeout: 20_000 }) });

export interface MirrorDescriptor {
  key: string;
  descriptorHash: string;
  path: string;
  commit: string;
  entity: string;
  kind: string;
  fileSha: string;
  attestation: string;
  owner: string;
  storageMode: string;
  swarmRef: string;
}
export interface MirrorDeployment {
  key: string;
  chainId: number;
  address: string;
  descriptorHash: string;
  proxyKind: string;
  monitored: boolean;
  commit: string;
}

const RAW_BASE = (commit: string) => `https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/${commit}/`;

const descSelect = {
  $key: true, descriptor_hash: true, registry_path: true, registry_commit: true, entity_dir: true, kind: true,
  file_sha: true, attestation: true, owner_name: true, storage_mode: true, swarm_ref: true,
} as const;
const depSelect = { $key: true, chain_id: true, address: true, descriptor_hash: true, proxy_kind: true, monitored: true, registry_commit: true } as const;

type DescRow = { $key: string; descriptor_hash: { value: string }; registry_path: { value: string }; registry_commit: { value: string }; entity_dir: { value: string }; kind: { value: string }; file_sha: { value: string }; attestation: { value: string }; owner_name: { value: string }; storage_mode: { value: string }; swarm_ref: { value: string } };
type DepRow = { $key: string; chain_id: { value: bigint }; address: { value: string }; descriptor_hash: { value: string }; proxy_kind: { value: string }; monitored: { value: boolean }; registry_commit: { value: string } };

export const toDescriptor = (r: DescRow): MirrorDescriptor => ({
  key: r.$key,
  descriptorHash: r.descriptor_hash.value,
  path: r.registry_path.value,
  commit: r.registry_commit.value,
  entity: r.entity_dir.value,
  kind: r.kind.value,
  fileSha: r.file_sha.value,
  attestation: r.attestation.value,
  owner: r.owner_name.value,
  storageMode: r.storage_mode.value,
  swarmRef: r.swarm_ref.value,
});
export const toDeployment = (r: DepRow): MirrorDeployment => ({
  key: r.$key,
  chainId: Number(r.chain_id.value),
  address: r.address.value,
  descriptorHash: r.descriptor_hash.value,
  proxyKind: r.proxy_kind.value,
  monitored: r.monitored.value,
  commit: r.registry_commit.value,
});

async function pageAll<T>(fetchPage: (offset: number) => Promise<{ entities: readonly T[]; skipped: number }>): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; ) {
    const page = await fetchPage(offset);
    out.push(...page.entities);
    const covered = page.entities.length + page.skipped;
    if (covered < 100) return out;
    offset += covered;
  }
}

export interface Mirror {
  descriptors: MirrorDescriptor[];
  deployments: MirrorDeployment[];
  commit: string;
  ms: number;
  queries: number;
}

let mirrorPromise: Promise<Mirror> | null = null;

/** Whole mirror, read once per session (contract-independent). */
export function loadMirror(): Promise<Mirror> {
  mirrorPromise ??= (async () => {
    const t0 = performance.now();
    let queries = 0;
    const descriptors = (
      await pageAll((o) => {
        queries++;
        return client.select(descSelect).from(DescriptorSchema).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(100).offset(o).fetch();
      })
    ).map((r) => toDescriptor(r as unknown as DescRow));
    const deployments = (
      await pageAll((o) => {
        queries++;
        return client.select(depSelect).from(DeploymentSchema).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(100).offset(o).fetch();
      })
    ).map((r) => toDeployment(r as unknown as DepRow));
    return { descriptors, deployments, commit: newestCommit(descriptors), ms: Math.round(performance.now() - t0), queries };
  })().catch((err) => {
    mirrorPromise = null; // allow a retry later
    throw err;
  });
  return mirrorPromise;
}

/** The commit most rows were last seen in (the importer patches rows to the newest pin). */
function newestCommit(rows: { commit: string }[]): string {
  const n = new Map<string, number>();
  for (const r of rows) n.set(r.commit, (n.get(r.commit) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/**
 * Turns mirror rows into the resolver's index shape. Only rows at `commit` are used, so a file
 * and its includes always come from the same registry snapshot.
 */
export function manifestFromMirror(descriptors: MirrorDescriptor[], deployments: MirrorDeployment[], commit: string): RegistryManifest {
  const atCommit = descriptors.filter((d) => d.commit === commit);
  const byHash = new Map(atCommit.filter((d) => d.kind !== "include").map((d) => [d.descriptorHash, d]));
  const calldataIndex: Record<string, string> = {};
  for (const dep of deployments) {
    const d = byHash.get(dep.descriptorHash);
    if (d?.kind === "calldata") calldataIndex[`eip155:${dep.chainId}:${dep.address.toLowerCase()}`] = d.path;
  }
  return {
    source: "arkiv mirror (dg_descriptor / dg_deployment)",
    license: "CC0-1.0",
    commit,
    rawBase: RAW_BASE(commit),
    generatedAt: "",
    calldataIndex,
    files: Object.fromEntries(atCommit.map((d) => [d.path, d.fileSha])),
    descriptors: Object.fromEntries(
      atCommit.map((d) => [d.path, { entity: d.entity, owner: d.owner, attested: d.attestation === "valid", deployments: 0, descriptorHash: d.descriptorHash || null }]),
    ),
    swarm: Object.fromEntries(
      atCommit
        .filter((d) => d.storageMode === "swarm" && /^[0-9a-f]{64}$/.test(d.swarmRef) && d.descriptorHash)
        .map((d) => [d.path, { ref: d.swarmRef, descriptorHash: d.descriptorHash, arkivKey: d.key }]),
    ),
  };
}

export type LookupMode = "bulk" | "targeted";
export interface ContractLookup {
  manifest: RegistryManifest;
  mode: LookupMode;
  descriptor: MirrorDescriptor | null;
  deployment: MirrorDeployment | null;
  note: string;
}

/**
 * Mirror metadata for one contract. Uses the bulk mirror when it loads; if the keyless budget
 * refuses it, queries this contract's rows (and its descriptor's includes) directly, and says so.
 */
export async function lookupContract(chainId: number, address: string): Promise<ContractLookup> {
  try {
    const m = await loadMirror();
    const manifest = manifestFromMirror(m.descriptors, m.deployments, m.commit);
    const dep = m.deployments.find((d) => d.chainId === chainId && d.address.toLowerCase() === address.toLowerCase()) ?? null;
    const desc = dep ? m.descriptors.find((d) => d.descriptorHash === dep.descriptorHash && d.commit === m.commit) ?? null : null;
    return { manifest, mode: "bulk", descriptor: desc, deployment: dep, note: `Bulk mirror read (${m.descriptors.length + m.deployments.length} rows, ${m.queries} queries, cached for this session): the Arkiv node can't tell which contract you checked.` };
  } catch {
    // Targeted fallback: this contract's deployment row, then descriptor rows at its commit.
    const deps = (
      await client.select(depSelect).from(DeploymentSchema).where(and(eq("chain_id", u64(BigInt(chainId))), eq("address", addr(address)))).createdBy(TRUSTED_CREATORS.writer).limit(10).fetch()
    ).entities.map((r) => toDeployment(r as unknown as DepRow));
    const dep = deps[0] ?? null;
    let descriptors: MirrorDescriptor[] = [];
    if (dep) {
      const desc = (
        await client.select(descSelect).from(DescriptorSchema).where(eq("descriptor_hash", dep.descriptorHash)).createdBy(TRUSTED_CREATORS.writer).limit(10).fetch()
      ).entities.map((r) => toDescriptor(r as unknown as DescRow));
      const main = desc.find((d) => d.commit === dep.commit) ?? desc[0];
      if (main) {
        // the commit's include files (common-*.json, ercs/*): ~22 rows, one query
        const inc = (
          await client.select(descSelect).from(DescriptorSchema).where(and(eq("kind", "include"), eq("registry_commit", main.commit))).createdBy(TRUSTED_CREATORS.writer).limit(100).fetch()
        ).entities.map((r) => toDescriptor(r as unknown as DescRow));
        descriptors = [main, ...inc];
      }
    }
    const commit = descriptors[0]?.commit ?? "";
    return {
      manifest: manifestFromMirror(descriptors, deps, commit),
      mode: "targeted",
      descriptor: descriptors[0] ?? null,
      deployment: dep,
      note: "The bulk mirror read was refused (keyless Arkiv budget), so this contract was looked up directly: the Arkiv node can see which contract you checked.",
    };
  }
}
