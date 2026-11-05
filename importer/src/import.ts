/**
 * Mirror the ERC-7730 registry (pinned commit) into Arkiv as dg_descriptor + dg_deployment rows.
 *
 *   npm run import -w importer -- <registry checkout> [--dry] [--no-classify]
 *
 * Idempotent and resumable: it first reads every row the writer already published, then only
 * creates what's missing and patches what changed (last-seen commit, attestation status, proxy
 * kind, monitored flag). Rows are never deleted: a changed file gets a new row (new file_sha /
 * descriptor_hash), and the old row stays as history with the last commit it was seen in.
 * Writes go out in executeBatch transactions of BATCH operations; an interrupted run simply
 * picks up from what's on Arkiv next time.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc } from "@arkiv-network/sdk/query";
import { addr, u64 } from "@arkiv-network/sdk/schema";
import { classifyContract, BaselineSchema, DeploymentSchema, DescriptorSchema, TRUSTED_CREATORS } from "@driftguard/core";
import { createPublicClient as viemClient, getAddress, http, isHex, type Address, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readRegistry, type DeploymentRow, type DescriptorRow } from "./registry.ts";

const BATCH = 50;
const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--"));
const dry = args.includes("--dry");
const classify = !args.includes("--no-classify");
if (!root) throw new Error("usage: import.ts <registry checkout> [--dry] [--no-classify]");

const log = (msg: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));
const key = process.env.ARKIV_WRITER_PRIVATE_KEY;
if (!dry && (!key || !isHex(key))) throw new Error("set ARKIV_WRITER_PRIVATE_KEY in .env");
const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" });
const pub = createPublicClient({ chain, transport: http() });
const account = key && isHex(key) ? privateKeyToAccount(key) : null;
if (account && account.address !== TRUSTED_CREATORS.writer) throw new Error(`writer key is ${account.address}, expected ${TRUSTED_CREATORS.writer}`);
const wallet = account ? createWalletClient({ chain, transport: http(), account }) : null;

// ---- 1. registry -----------------------------------------------------------------------------
const snap = readRegistry(root);
log("registry read", {
  commit: snap.commit,
  descriptors: snap.descriptors.length,
  deployments: snap.deployments.length,
  attestation: Object.fromEntries(["valid", "stale", "none"].map((s) => [s, snap.descriptors.filter((d) => d.kind !== "include" && d.attestation === s).length])),
});

// ---- 2. proxy kind for mainnet deployments (cached per commit, so reruns are cheap) ----------
const kinds = new Map<string, string>();
if (classify) {
  const stateDir = fileURLToPath(new URL("../state/", import.meta.url));
  mkdirSync(stateDir, { recursive: true });
  const cachePath = `${stateDir}classification-${snap.commit.slice(0, 12)}.json`;
  const cache: Record<string, string> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const client = viemClient({ chain: mainnet, transport: http(process.env.MAINNET_RPC_URL, { retryCount: 3 }) });
  const block = (await client.getBlockNumber()) - 2n;
  const todo = [...new Set(snap.deployments.filter((d) => d.chainId === 1).map((d) => d.address.toLowerCase()))].filter((a) => !cache[a]);
  log("classifying mainnet deployments", { cached: Object.keys(cache).length, todo: todo.length });
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            cache[a] = (await classifyContract(client, getAddress(a), block)).kind;
            break;
          } catch {
            if (attempt === 2) cache[a] = "unknown";
            else await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          }
        }
      }
    }),
  );
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));
  for (const [a, k] of Object.entries(cache)) kinds.set(a, k);
}
const proxyKindOf = (d: DeploymentRow) => (d.chainId === 1 ? kinds.get(d.address.toLowerCase()) ?? "unchecked" : "unchecked");

// ---- 3. what is already on Arkiv (writer's rows only) ----------------------------------------
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
const [existingDesc, existingDep, baselines] = await Promise.all([
  pageAll((o) =>
    pub.select({ $key: true, registry_path: true, file_sha: true, descriptor_hash: true, registry_commit: true, attestation: true })
      .from(DescriptorSchema).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(100).offset(o).fetch(),
  ),
  pageAll((o) =>
    pub.select({ $key: true, chain_id: true, address: true, descriptor_hash: true, registry_commit: true, proxy_kind: true, monitored: true })
      .from(DeploymentSchema).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(100).offset(o).fetch(),
  ),
  pageAll((o) => pub.select({ chain_id: true, address: true }).from(BaselineSchema).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(100).offset(o).fetch()),
]);
const monitored = new Set(baselines.map((b) => `${b.chain_id.value}:${b.address.value.toLowerCase()}`));
log("arkiv state", { descriptors: existingDesc.length, deployments: existingDep.length, baselines: baselines.length });

const descKey = (path: string, fileSha: string, hash: string) => `${path}|${fileSha}|${hash}`;
const depKey = (chainId: number | bigint, address: string, hash: string) => `${chainId}:${address.toLowerCase()}|${hash}`;
const descOnChain = new Map(existingDesc.map((r) => [descKey(r.registry_path.value, r.file_sha.value, r.descriptor_hash.value), r]));
const depOnChain = new Map(existingDep.map((r) => [depKey(r.chain_id.value, r.address.value, r.descriptor_hash.value), r]));

// ---- 4. plan ---------------------------------------------------------------------------------
const now = u64(BigInt(Math.floor(Date.now() / 1000)));
// The SDK types creates/patches per schema; ops for two schemas share one batch, so they are
// kept loosely typed here and checked by the SDK at runtime (schema validation on write).
type Op =
  | { kind: "create"; schema: typeof DescriptorSchema | typeof DeploymentSchema; values: Record<string, unknown> }
  | { kind: "patch"; schema: typeof DescriptorSchema | typeof DeploymentSchema; entityKey: Hex; set: Record<string, unknown> };
const ops: Op[] = [];
const descValues = (d: DescriptorRow) => ({
  descriptor_hash: d.descriptorHash,
  registry_path: d.registryPath,
  registry_commit: snap.commit,
  entity_dir: d.entityDir,
  kind: d.kind,
  swarm_ref: "",
  storage_mode: "registry",
  size_bytes: u64(BigInt(d.sizeBytes)),
  file_sha: d.fileSha,
  schema_version: d.schemaVersion,
  owner_name: d.ownerName,
  attestation: d.attestation,
  imported_at: now,
});
let unchanged = 0;
for (const d of snap.descriptors) {
  const ex = descOnChain.get(descKey(d.registryPath, d.fileSha, d.descriptorHash));
  if (!ex) ops.push({ kind: "create", schema: DescriptorSchema, values: descValues(d) });
  else if (ex.registry_commit.value !== snap.commit || ex.attestation.value !== d.attestation) {
    ops.push({ kind: "patch", schema: DescriptorSchema, entityKey: ex.$key, set: { registry_commit: snap.commit, attestation: d.attestation } });
  } else unchanged++;
}
for (const d of snap.deployments) {
  const isMonitored = monitored.has(`${d.chainId}:${d.address.toLowerCase()}`);
  const pk = proxyKindOf(d);
  const ex = depOnChain.get(depKey(d.chainId, d.address, d.descriptorHash));
  if (!ex) {
    ops.push({
      kind: "create",
      schema: DeploymentSchema,
      values: { chain_id: u64(BigInt(d.chainId)), address: addr(d.address), descriptor_hash: d.descriptorHash, registry_commit: snap.commit, proxy_kind: pk, monitored: isMonitored },
    });
  } else if (ex.registry_commit.value !== snap.commit || ex.proxy_kind.value !== pk || ex.monitored.value !== isMonitored) {
    ops.push({ kind: "patch", schema: DeploymentSchema, entityKey: ex.$key, set: { registry_commit: snap.commit, proxy_kind: pk, monitored: isMonitored } });
  } else unchanged++;
}
const creates = ops.filter((o) => o.kind === "create").length;
log("plan", { creates, patches: ops.length - creates, unchanged, batches: Math.ceil(ops.length / BATCH), dry });
if (dry || ops.length === 0) process.exit(0);

// ---- 5. write --------------------------------------------------------------------------------
const startBal = await pub.getBalance({ address: account!.address });
const t0 = Date.now();
let done = 0;
for (let i = 0; i < ops.length; i += BATCH) {
  const group = ops.slice(i, i + BATCH);
  const send = () =>
    wallet!.executeBatch({
      creates: group.flatMap((o) => (o.kind === "create" ? [{ schema: o.schema, values: o.values, expiration: ExpirationTime.max() }] : [])) as never,
      patches: group.flatMap((o) => (o.kind === "patch" ? [{ schema: o.schema, entityKey: o.entityKey, set: o.set }] : [])) as never,
    });
  try {
    await send();
  } catch (err) {
    log("batch failed, retrying once", { batch: i / BATCH, error: String(err).split("\n")[0] });
    await new Promise((r) => setTimeout(r, 5000));
    await send(); // a second failure aborts; rerunning resumes from what is on Arkiv
  }
  done += group.length;
  if ((i / BATCH) % 5 === 0 || done === ops.length) log("progress", { done, total: ops.length, elapsedS: Math.round((Date.now() - t0) / 1000) });
}
const endBal = await pub.getBalance({ address: account!.address });
log("import done", { ops: ops.length, seconds: Math.round((Date.now() - t0) / 1000), costTGLM: Number(startBal - endBal) / 1e18, writerBalanceTGLM: Number(endBal) / 1e18 });
