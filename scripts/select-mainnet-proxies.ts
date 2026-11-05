/**
 * Picks the mainnet contracts the watcher monitors: classifies every chain-1 deployment in the
 * ERC-7730 registry (at a pinned commit) by reading its proxy slots, then selects up to 30
 * upgradeable proxies — those whose descriptor has an auditor attestation in `sigs/` first.
 *
 *   node --env-file=.env scripts/select-mainnet-proxies.ts <registry checkout> [--max 30]
 *
 * Writes watcher/monitored-mainnet.json (committed) with the selection and classification stats.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { createPublicClient, http, getAddress, zeroAddress, type Address } from "viem";
import { mainnet } from "viem/chains";
import { classifyContract } from "@driftguard/core";

const root = process.argv[2];
if (!root || !existsSync(join(root, "registry"))) throw new Error("usage: select-mainnet-proxies.ts <registry checkout>");
const maxIdx = process.argv.indexOf("--max");
const MAX = maxIdx > 0 ? Number(process.argv[maxIdx + 1]) : 30;
const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();

// ---- 1. registry: chain-1 deployments of calldata descriptors ------------------------------
interface Candidate { address: Address; descriptor: string; entity: string; attested: boolean }
const files: string[] = [];
(function walk(d: string) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (!/^(tests|testsv2|sigs)$/.test(e.name)) walk(p); }
    else if (/^calldata-.*\.json$/.test(e.name) && !e.name.endsWith(".tests.json")) files.push(p);
  }
})(join(root, "registry"));

const byAddress = new Map<string, Candidate>();
for (const f of files) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  const stem = basename(f, ".json");
  const sigs = join(dirname(f), "sigs");
  const attested = existsSync(sigs) && readdirSync(sigs).some((s) => s.startsWith(`${stem}.eip155-`));
  for (const d of j.context?.contract?.deployments ?? []) {
    if (d.chainId !== 1) continue;
    const key = String(d.address).toLowerCase();
    const prev = byAddress.get(key);
    // keep the attested descriptor if one address appears in several
    if (!prev || (!prev.attested && attested)) {
      byAddress.set(key, { address: getAddress(d.address), descriptor: relative(root, f).replaceAll("\\", "/"), entity: basename(dirname(f)), attested });
    }
  }
}
const candidates = [...byAddress.values()];
console.log(`registry ${commit.slice(0, 7)}: ${files.length} calldata descriptors, ${candidates.length} unique mainnet addresses, ${candidates.filter((c) => c.attested).length} attested`);

// ---- 2. classify on-chain -------------------------------------------------------------------
const client = createPublicClient({ chain: mainnet, transport: http(process.env.MAINNET_RPC_URL, { retryCount: 3 }) });
const block = (await client.getBlockNumber()) - 2n;
const classify = (a: Address) => classifyContract(client, a, block);

const results: (Candidate & { kind: string; implementation: Address })[] = [];
const queue = [...candidates];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      let done = false;
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        try { results.push({ ...c, ...(await classify(c.address)) }); done = true; }
        catch (err) {
          if (attempt < 2) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; } // public RPC "limit exceeded"
          results.push({ ...c, kind: "error", implementation: zeroAddress });
          console.error(c.address, String(err).slice(0, 120));
        }
      }
      if (results.length % 50 === 0) console.log(`classified ${results.length}/${candidates.length}`);
    }
  }),
);

// ---- 3. select ------------------------------------------------------------------------------
const stats: Record<string, number> = {};
for (const r of results) stats[r.kind] = (stats[r.kind] ?? 0) + 1;
const proxies = results.filter((r) => ["eip1967", "beacon", "diamond", "safe"].includes(r.kind));
// Order: attested proxies (≤3 per entity), then beacons/diamonds/Safes (≤1 per entity, so every
// detectable proxy kind is covered), then other proxies spread across entities (≤2 each), and
// only then the remaining attested ones. Without the caps, ~20 Kiln vaults behind shared beacons
// fill the list and add little coverage.
const byName = (a: (typeof results)[number], b: (typeof results)[number]) =>
  a.entity.localeCompare(b.entity) || a.address.localeCompare(b.address);
const sorted = [...proxies].sort(byName);
const selected: typeof results = [];
const perEntity = new Map<string, number>();
const take = (pred: (r: (typeof results)[number]) => boolean, cap: number) => {
  for (const r of sorted) {
    if (selected.length >= MAX || selected.includes(r) || !pred(r)) continue;
    const n = perEntity.get(r.entity) ?? 0;
    if (n >= cap) continue;
    selected.push(r);
    perEntity.set(r.entity, n + 1);
  }
};
take((r) => r.attested, 3);
take((r) => r.kind === "beacon" || r.kind === "diamond" || r.kind === "safe", 1);
take(() => true, 2);
take((r) => r.attested, Infinity);

const out = {
  generatedAt: new Date().toISOString(),
  registry: { repo: "ethereum/clear-signing-erc7730-registry", commit, license: "CC0-1.0" },
  classifiedAtBlock: block.toString(),
  stats: { mainnetAddresses: results.length, attested: results.filter((r) => r.attested).length, byKind: stats, attestedProxies: proxies.filter((p) => p.attested).length },
  selected: selected.map(({ address, kind, implementation, entity, descriptor, attested }) => ({ chainId: 1, address, kind, implementation, entity, descriptor, attested })),
};
writeFileSync("watcher/monitored-mainnet.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out.stats, null, 2));
console.log(`selected ${selected.length} (${selected.filter((s) => s.attested).length} attested) → watcher/monitored-mainnet.json`);
