/**
 * Builds the web app's registry manifest from a checkout of the ERC-7730 registry at a pinned
 * commit (the "registry fallback" storage mode in docs/ARCHITECTURE.md §3, used until Swarm is set
 * up). For every file the resolver may need it records keccak256(raw bytes), so the browser can
 * fetch from GitHub (or any mirror) and reject anything that doesn't match. For every calldata
 * descriptor it records the ERC-8176 descriptor hash of the fully resolved descriptor.
 *
 *   node scripts/build-registry-index.ts .cache/registry   →   web/public/registry-index.json
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { keccak256, toHex, getAddress } from "viem";
import { computeDescriptorHash, resolveCalldataDescriptor, type RegistryIndex } from "@ethereum-sourcify/clear-signing";
import { createFilesystemResolver } from "@ethereum-sourcify/clear-signing/filesystem";

const root = process.argv[2];
if (!root || !existsSync(join(root, "registry"))) throw new Error("usage: build-registry-index.ts <registry checkout>");
const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
const rel = (p: string) => relative(root, p).replaceAll("\\", "/");

// 1. every JSON file a descriptor can reach (descriptors, common-*.json, ercs/), minus tests/sigs
const files: Record<string, string> = {};
const calldataFiles: string[] = [];
function walk(d: string) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) {
      if (!/^(tests|testsv2|sigs)$/.test(e.name)) walk(p);
    } else if (e.name.endsWith(".json") && !e.name.endsWith(".tests.json")) {
      files[rel(p)] = keccak256(toHex(readFileSync(p)));
      if (e.name.startsWith("calldata-")) calldataFiles.push(p);
    }
  }
}
walk(join(root, "registry"));
if (existsSync(join(root, "ercs"))) walk(join(root, "ercs"));
if (existsSync(join(root, "specs"))) walk(join(root, "specs"));

// 2. CAIP-10 → descriptor path, from each descriptor's own deployments
const calldataIndex: Record<string, string> = {};
const meta: Record<string, { entity: string; owner: string; attested: boolean; deployments: number }> = {};
for (const f of calldataFiles) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  const path = rel(f);
  const stem = basename(f, ".json");
  const sigs = join(dirname(f), "sigs");
  const attested = existsSync(sigs) && readdirSync(sigs).some((s) => s.startsWith(`${stem}.eip155-`));
  const deployments: { chainId: number; address: string }[] = j.context?.contract?.deployments ?? [];
  meta[path] = { entity: basename(dirname(f)), owner: String(j.metadata?.owner ?? "").slice(0, 80), attested, deployments: deployments.length };
  for (const d of deployments) {
    const key = `eip155:${d.chainId}:${String(d.address).toLowerCase()}`;
    if (!calldataIndex[key] || (attested && !meta[calldataIndex[key]!]?.attested)) calldataIndex[key] = path;
  }
}

// 3. ERC-8176 hash of each resolved descriptor (resolving `includes` from the checkout)
const index: RegistryIndex = { calldataIndex, typedDataIndex: {} };
const resolver = createFilesystemResolver({ index, descriptorDirectory: root });
const descriptorHash: Record<string, string> = {};
const firstDeployment = new Map<string, string>();
for (const [caip, path] of Object.entries(calldataIndex)) if (!firstDeployment.has(path)) firstDeployment.set(path, caip);
let failed = 0;
for (const [path, caip] of firstDeployment) {
  const [, chainId, address] = caip.split(":");
  const r = await resolveCalldataDescriptor(Number(chainId), getAddress(address!), { type: "custom", resolver });
  if ("descriptor" in r) descriptorHash[path] = computeDescriptorHash(r.descriptor);
  else failed++;
}

const out = {
  source: "ethereum/clear-signing-erc7730-registry",
  license: "CC0-1.0",
  commit,
  rawBase: `https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/${commit}/`,
  generatedAt: new Date().toISOString(),
  /** CAIP-10 → descriptor path (clear-signing RegistryIndex.calldataIndex) */
  calldataIndex,
  /** path → keccak256 of the raw file bytes, for every file a descriptor may include */
  files,
  /** descriptor path → ERC-8176 hash of the resolved descriptor + registry metadata */
  descriptors: Object.fromEntries(Object.entries(meta).map(([p, m]) => [p, { ...m, descriptorHash: descriptorHash[p] ?? null }])),
};
const target = "web/public/registry-index.json";
writeFileSync(target, JSON.stringify(out));
console.log(
  `registry ${commit.slice(0, 7)}: ${Object.keys(files).length} files hashed, ${calldataFiles.length} calldata descriptors, ` +
    `${Object.keys(calldataIndex).length} deployments, ${Object.keys(descriptorHash).length} descriptor hashes (${failed} failed) → ${target} ` +
    `(${Math.round(statSync(target).size / 1024)} KiB)`,
);
