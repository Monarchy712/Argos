/**
 * Writes baselines (writer wallet) for every contract in watcher/monitored-mainnet.json that has
 * no baseline yet. Idempotent: re-running skips contracts already baselined, so it never moves an
 * existing baseline (only `rebaseline` does that, explicitly).
 *
 *   npm run seed -w watcher [-- --dry]
 */
import { readFileSync } from "node:fs";
import { codeIdentityHash, readIdentity, type ProxyKind } from "@driftguard/core";
import { getAddress, type Address } from "viem";
import { clientFor, loadConfig } from "./config.ts";
import { ArkivSink } from "./arkivSink.ts";
import { contractId } from "./types.ts";

const dry = process.argv.includes("--dry");
const list = JSON.parse(readFileSync(new URL("../monitored-mainnet.json", import.meta.url), "utf8")) as {
  registry: { commit: string };
  selected: { chainId: number; address: Address; kind: ProxyKind; entity: string; attested: boolean }[];
};

const config = loadConfig();
const sink = ArkivSink.fromEnv();
const existing = new Set((await sink.loadBaselines()).map((b) => contractId(b.chainId, b.address)));
const todo = list.selected.filter((c) => !existing.has(contractId(c.chainId, c.address)));
console.log(`${list.selected.length} selected, ${existing.size} baselines on Arkiv, ${todo.length} to write`);

for (const c of todo) {
  const client = clientFor(c.chainId);
  const block = (await client.getBlockNumber()) - config.confirmations;
  const identity = await readIdentity(client, getAddress(c.address), c.kind, block);
  if (dry) {
    console.log("would baseline", c.entity, c.address, c.kind, identity.implementation);
    continue;
  }
  const key = await sink.writeBaseline({
    chainId: c.chainId,
    address: getAddress(c.address),
    identity,
    identityHash: codeIdentityHash(identity),
    block,
    baselinedAt: Math.floor(Date.now() / 1000),
    descriptorHash: "",
    swarmRef: "",
    reason: `seed: ${c.entity}${c.attested ? " (attested descriptor)" : ""}, registry ${list.registry.commit.slice(0, 7)}`,
    previousKey: "",
  });
  console.log("baselined", c.entity, c.address, c.kind, "→", key);
}
