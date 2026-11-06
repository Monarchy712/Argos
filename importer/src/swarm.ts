/**
 * Puts the mirrored descriptors on Swarm and records the references on Arkiv.
 *
 *   npm run swarm -w importer -- <registry checkout> [--dry] [--limit N] [--no-arkiv]
 *        [--public-gateway]   upload through the public gateway without our own postage batch
 *                             (the gateway stamps it; retention is the gateway operator's call)
 *        [--restamp]          re-upload descriptors already on Swarm (with our batch, or with
 *                             --public-gateway) and assert each reference is unchanged; no Arkiv
 *                             writes. Use it to put the content under our own postage batch.
 *
 * For each dg_descriptor row (writer wallet) at the checkout's commit that isn't on Swarm yet:
 *  1. bytes = RFC 8785 JCS of the resolved descriptor (from registry.ts), and
 *     keccak256(bytes) must equal the row's descriptor_hash (ERC-8176). So one hash proves both
 *     "these are the bytes Swarm returned" and "this is the ERC-8176 descriptor".
 *  2. Upload unencrypted with `bee.data.upload(batch, bytes)` (POST /bytes). Encrypted references
 *     embed their decryption key, so they never go into an Arkiv entity; we assert a 64-hex ref.
 *  3. Download it back (GET /bytes/:ref) and check keccak256 again before trusting the ref.
 *  4. Patch the Arkiv row: swarm_ref = ref, storage_mode = "swarm" (executeBatch, 20 per tx).
 *
 * Idempotent and resumable: refs are cached in importer/state/swarm-<commit>.json, rows already
 * marked "swarm" are skipped, and unencrypted Swarm references are content addresses, so a
 * re-upload of the same bytes yields the same ref. Include files have no ERC-8176 hash and stay
 * storage_mode = "registry" (they are already merged into the resolved descriptors).
 *
 * Env: BEE_API_URL, SWARM_POSTAGE_BATCH_ID (upload); ARKIV_WRITER_PRIVATE_KEY (patch).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Bee } from "@ethersphere/bee-js";
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc } from "@arkiv-network/sdk/query";
import { describeError, DescriptorSchema, TRUSTED_CREATORS } from "@driftguard/core";
import { http, isHex, keccak256, stringToBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readRegistry } from "./registry.ts";

const PUBLIC_GATEWAY = process.env.SWARM_PUBLIC_GATEWAY ?? "https://api.gateway.ethswarm.org";
const BATCH = 20;
const CONCURRENCY = 4;
const args = process.argv.slice(2);
const root = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit");
const dry = args.includes("--dry");
const publicGateway = args.includes("--public-gateway");
const restamp = args.includes("--restamp");
const noArkiv = args.includes("--no-arkiv") || restamp;
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
if (!root) throw new Error("usage: swarm.ts <registry checkout> [--dry] [--limit N] [--no-arkiv]");

const log = (msg: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));
const redact = (s: string) => s.replace(/[0-9a-f]{64}/gi, (m) => (m === batchId ? "<batch>" : m));

const beeUrl = publicGateway ? PUBLIC_GATEWAY : process.env.BEE_API_URL ?? "";
const batchId = publicGateway ? "" : (process.env.SWARM_POSTAGE_BATCH_ID ?? "").replace(/^0x/, "").toLowerCase();
if (!dry && !publicGateway && (!beeUrl || !/^[0-9a-f]{64}$/.test(batchId))) {
  throw new Error("set BEE_API_URL and SWARM_POSTAGE_BATCH_ID (64 hex) in .env, or pass --public-gateway / --dry");
}
const key = process.env.ARKIV_WRITER_PRIVATE_KEY;
if (!dry && !noArkiv && (!key || !isHex(key))) throw new Error("set ARKIV_WRITER_PRIVATE_KEY in .env (or pass --no-arkiv)");

const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" });
const pub = createPublicClient({ chain, transport: http() });

// ---- 1. registry + what's on Arkiv ----------------------------------------------------------
const snap = readRegistry(root);
const rows: { $key: Hex; registry_path: { value: string }; descriptor_hash: { value: string }; storage_mode: { value: string }; swarm_ref: { value: string }; registry_commit: { value: string } }[] = [];
for (let offset = 0; ; ) {
  const page = await pub
    .select({ $key: true, registry_path: true, descriptor_hash: true, storage_mode: true, swarm_ref: true, registry_commit: true })
    .from(DescriptorSchema).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(100).offset(offset).fetch();
  rows.push(...(page.entities as unknown as typeof rows));
  const covered = page.entities.length + page.skipped;
  if (covered < 100) break;
  offset += covered;
}
const rowFor = new Map(rows.map((r) => [`${r.registry_path.value}|${r.descriptor_hash.value}`, r]));
const candidates = snap.descriptors.filter((d) => d.kind !== "include" && d.jcs && d.descriptorHash);
const missingRow = candidates.filter((d) => !rowFor.has(`${d.registryPath}|${d.descriptorHash}`));
const pending = candidates
  .map((d) => ({ d, row: rowFor.get(`${d.registryPath}|${d.descriptorHash}`)! }))
  .filter(({ row }) => {
    const onSwarm = row && row.storage_mode.value === "swarm" && /^[0-9a-f]{64}$/.test(row.swarm_ref.value);
    return row && (restamp ? onSwarm : !onSwarm);
  });
const todo = pending.slice(0, limit);
log("plan", {
  commit: snap.commit.slice(0, 7),
  descriptors: candidates.length,
  alreadyOnSwarm: candidates.length - missingRow.length - pending.length,
  toUpload: todo.length,
  mode: `${restamp ? "restamp, " : ""}${publicGateway ? "public gateway (gateway stamp)" : "own batch"}`,
  missingArkivRow: missingRow.length,
  bytes: todo.reduce((n, { d }) => n + Buffer.byteLength(d.jcs!), 0),
  dry,
});
if (missingRow.length) log("run the importer first for these rows", { paths: missingRow.slice(0, 5).map((d) => d.registryPath) });
if (dry || todo.length === 0) process.exit(0);

// ---- 2. upload + verify ---------------------------------------------------------------------
const bee = new Bee(beeUrl);
/** POST /bytes. With our batch via bee-js; through the public gateway with no stamp header
 *  (the gateway attaches its own), which bee-js can't express because it requires a batch ID. */
async function uploadBytes(bytes: Uint8Array): Promise<string> {
  if (!publicGateway) return (await bee.data.upload(batchId, bytes)).reference.toHex().toLowerCase();
  const res = await fetch(`${beeUrl}/bytes`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from(bytes), signal: AbortSignal.timeout(60_000) });
  if (res.status !== 201 && res.status !== 200) throw new Error(`gateway upload HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return String(((await res.json()) as { reference?: string }).reference ?? "").toLowerCase();
}
if (!publicGateway) try {
  const b = await bee.stamp.get(batchId);
  log("postage batch", { usable: b.usable, depth: b.depth, utilization: b.utilization, usage: b.usageText, ttlSeconds: b.duration.toSeconds() });
  if (!b.usable) throw new Error("postage batch is not usable yet (Bee waits a few blocks after purchase)");
} catch (err) {
  // Some hosted upload endpoints don't expose /stamps; the upload itself will tell us.
  log("could not read the postage batch from this node (continuing)", { error: redact(describeError(err)) });
}

const stateDir = fileURLToPath(new URL("../state/", import.meta.url));
mkdirSync(stateDir, { recursive: true });
const cachePath = `${stateDir}swarm-${snap.commit.slice(0, 12)}.json`;
const cache: Record<string, string> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
const t0 = Date.now();
let uploaded = 0;
let failed = 0;
const queue = [...todo];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { d } = item;
      const hash = d.descriptorHash as Hex;
      if (cache[hash] && !restamp) continue;
      const bytes = stringToBytes(d.jcs!);
      if (keccak256(bytes) !== hash) throw new Error(`JCS bytes of ${d.registryPath} don't hash to its descriptor_hash; aborting`);
      try {
        const ref = await uploadBytes(bytes);
        if (!/^[0-9a-f]{64}$/.test(ref)) throw new Error(`unexpected reference length ${ref.length} (encrypted?)`);
        const back = await bee.data.download(ref);
        const got = keccak256(toHex(back.toUint8Array()));
        if (got !== hash) throw new Error(`downloaded bytes hash ${got}, expected ${hash}`);
        if (restamp && ref !== item.row.swarm_ref.value) throw new Error(`restamp gave ref ${ref}, Arkiv has ${item.row.swarm_ref.value}`);
        cache[hash] = ref;
        uploaded++;
        if (uploaded % 25 === 0) {
          writeFileSync(cachePath, JSON.stringify(cache, null, 1));
          log("progress", { uploaded, of: todo.length, elapsedS: Math.round((Date.now() - t0) / 1000) });
        }
      } catch (err) {
        failed++;
        log("upload failed", { path: d.registryPath, error: redact(describeError(err)) });
        if (failed >= 5 && uploaded === 0) throw new Error("5 uploads failed and none succeeded; stopping (check BEE_API_URL / batch)");
      }
    }
  }),
);
writeFileSync(cachePath, JSON.stringify(cache, null, 1));
log("uploads done", { uploaded, failed, cached: Object.keys(cache).length, seconds: Math.round((Date.now() - t0) / 1000) });

// ---- 3. public gateway retrieval check (one sample) -----------------------------------------
const sample = todo.find(({ d }) => cache[d.descriptorHash]);
if (sample) {
  const ref = cache[sample.d.descriptorHash]!;
  try {
    const res = await fetch(`${PUBLIC_GATEWAY}/bytes/${ref}`, { signal: AbortSignal.timeout(30_000) });
    const ok = res.ok && keccak256(new Uint8Array(await res.arrayBuffer())) === sample.d.descriptorHash;
    log("public gateway check", { url: `${PUBLIC_GATEWAY}/bytes/${ref}`, status: res.status, hashMatches: ok, path: sample.d.registryPath, arkivEntity: sample.row.$key });
  } catch (err) {
    log("public gateway check failed (content may still be syncing)", { error: describeError(err) });
  }
}

// ---- 4. record refs on Arkiv ----------------------------------------------------------------
if (noArkiv) process.exit(failed ? 1 : 0);
const account = privateKeyToAccount(key as Hex);
if (account.address !== TRUSTED_CREATORS.writer) throw new Error(`writer key is ${account.address}, expected ${TRUSTED_CREATORS.writer}`);
const wallet = createWalletClient({ chain, transport: http(), account });
const patches = todo
  .filter(({ d }) => cache[d.descriptorHash])
  .map(({ d, row }) => ({ schema: DescriptorSchema, entityKey: row.$key, set: { swarm_ref: cache[d.descriptorHash]!, storage_mode: "swarm" } }));
let patched = 0;
for (let i = 0; i < patches.length; i += BATCH) {
  const group = patches.slice(i, i + BATCH);
  try {
    await wallet.executeBatch({ patches: group as never });
  } catch (err) {
    log("patch batch failed, retrying once", { size: group.length, error: describeError(err) });
    await new Promise((r) => setTimeout(r, 5000));
    await wallet.executeBatch({ patches: group as never });
  }
  patched += group.length;
  log("arkiv patched", { patched, of: patches.length });
}
log("swarm import done", { uploaded, failed, patched });
process.exit(failed ? 1 : 0);
