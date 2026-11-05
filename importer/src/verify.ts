/**
 * Verifies the Arkiv mirror from a client's point of view (read-only, no keys needed):
 *  1. counts of dg_descriptor / dg_deployment rows by the trusted writer at a commit match the
 *     registry checkout;
 *  2. N random descriptors: fetch the file (and its includes) from GitHub raw at the row's
 *     registry_commit + registry_path, check keccak256(bytes) == file_sha, resolve includes,
 *     and check computeDescriptorHash == descriptor_hash.
 *
 *   npm run verify -w importer -- <registry checkout> [--samples 10]
 */
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc, eq } from "@arkiv-network/sdk/query";
import { DeploymentSchema, DescriptorSchema, TRUSTED_CREATORS } from "@driftguard/core";
import { computeDescriptorHash, mergeDescriptors } from "@ethereum-sourcify/clear-signing";
import { http, keccak256, toHex } from "viem";
import { posix } from "node:path";
import { readRegistry } from "./registry.ts";

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--"));
const samplesIdx = args.indexOf("--samples");
const SAMPLES = samplesIdx >= 0 ? Number(args[samplesIdx + 1]) : 10;
if (!root) throw new Error("usage: verify.ts <registry checkout> [--samples N]");

const pub = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });
const snap = readRegistry(root);
const commit = snap.commit;
let ok = true;
const check = (name: string, pass: boolean, note = "") => {
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${note ? ` — ${note}` : ""}`);
};

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

// ---- 1. counts ---------------------------------------------------------------------------------
const t0 = performance.now();
const descRows = await pageAll((o) =>
  pub.select({ $key: true, kind: true, registry_path: true, registry_commit: true, file_sha: true, descriptor_hash: true, attestation: true })
    .from(DescriptorSchema).where(eq("registry_commit", commit)).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(100).offset(o).fetch(),
);
const depRows = await pageAll((o) =>
  pub.select({ $key: true }).from(DeploymentSchema).where(eq("registry_commit", commit)).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(100).offset(o).fetch(),
);
const readMs = Math.round(performance.now() - t0);
const byKind = (rows: { kind: string }[]) => Object.fromEntries(["calldata", "eip712", "include"].map((k) => [k, rows.filter((r) => r.kind === k).length]));
const arkivKinds = byKind(descRows.map((r) => ({ kind: r.kind.value })));
const regKinds = byKind(snap.descriptors);
console.log(`commit ${commit.slice(0, 7)} · read ${descRows.length + depRows.length} rows in ${readMs} ms`);
check("dg_descriptor count matches registry", descRows.length === snap.descriptors.length, `arkiv ${JSON.stringify(arkivKinds)} vs registry ${JSON.stringify(regKinds)}`);
check("dg_deployment count matches registry", depRows.length === snap.deployments.length, `arkiv ${depRows.length} vs registry ${snap.deployments.length}`);
const stale = descRows.filter((r) => r.attestation.value === "stale").map((r) => r.registry_path.value);
console.log(`attestation=stale on Arkiv: ${stale.join(", ") || "none"}`);

// ---- 2. spot checks against GitHub raw ---------------------------------------------------------
const raw = (c: string, p: string) => `https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/${c}/${p}`;
async function fetchJson(c: string, p: string) {
  const res = await fetch(raw(c, p));
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${p}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, json: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> };
}
async function resolveFromGithub(c: string, p: string): Promise<Record<string, unknown>> {
  const { json } = await fetchJson(c, p);
  if (typeof json.includes !== "string") return json;
  const inc = posix.normalize(posix.join(posix.dirname(p), json.includes));
  return mergeDescriptors(json as never, (await resolveFromGithub(c, inc)) as never) as unknown as Record<string, unknown>;
}

const candidates = descRows.filter((r) => r.kind.value !== "include");
const picks = [...candidates].sort(() => Math.random() - 0.5).slice(0, SAMPLES);
for (const r of picks) {
  const c = r.registry_commit.value;
  const p = r.registry_path.value;
  try {
    const { bytes } = await fetchJson(c, p);
    const sha = keccak256(toHex(bytes));
    const hash = computeDescriptorHash((await resolveFromGithub(c, p)) as never);
    const pass = sha === r.file_sha.value && hash === r.descriptor_hash.value;
    check(`spot-check ${p}`, pass, pass ? `file_sha ✓ descriptor_hash ✓ (${hash.slice(0, 12)}…) @ ${c.slice(0, 7)}` : `file_sha ${sha === r.file_sha.value} descriptor_hash ${hash === r.descriptor_hash.value}`);
  } catch (err) {
    check(`spot-check ${p}`, false, String(err).split("\n")[0]);
  }
}
console.log(ok ? "MIRROR VERIFY: PASS" : "MIRROR VERIFY: FAIL");
process.exitCode = ok ? 0 : 1;
