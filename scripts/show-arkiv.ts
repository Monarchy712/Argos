/**
 * Prints every monitored contract's baseline, current_state and latest_change from Arkiv,
 * trusting only DriftGuard's writer/watcher wallets — the same reads the web app does.
 * Read-only; works without any private key (keyless, or with ARKIV_ACCESS_KEY if set).
 *
 *   node --env-file-if-exists=.env scripts/show-arkiv.ts [--json]
 */
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http } from "viem";
import { BaselineSchema, CurrentStateSchema, LatestChangeSchema, TRUSTED_CREATORS } from "@driftguard/core";

const pub = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });
const [baselines, states, changes] = await Promise.all([
  pub.select().from(BaselineSchema).createdBy(TRUSTED_CREATORS.writer).limit(100).fetch(),
  pub.select().from(CurrentStateSchema).createdBy(TRUSTED_CREATORS.watcher).limit(100).fetch(),
  pub.select().from(LatestChangeSchema).createdBy(TRUSTED_CREATORS.watcher).limit(100).fetch(),
]);

const id = (r: { chain_id: { value: bigint }; address: { value: string } }) => `${r.chain_id.value}:${r.address.value.toLowerCase()}`;
const head = baselines.blockNumber;
const rows = baselines.entities.map((b) => {
  const s = states.entities.find((x) => id(x) === id(b));
  const c = changes.entities.find((x) => id(x) === id(b));
  return {
    contract: id(b),
    baseline: { key: b.$key, implementation: b.implementation.value, block: b.baseline_block.value.toString() },
    current: s
      ? {
          key: s.$key,
          implementation: s.implementation.value,
          matches_baseline: s.matches_baseline.value,
          ever_changed_since_baseline: s.ever_changed_since_baseline.value,
          checked_block: s.checked_block.value.toString(),
          checked_age_s: Math.floor(Date.now() / 1000) - Number(s.checked_at.value),
          expires_in_s: Number(s.$expiresAt - head) * 2,
        }
      : "none (expired or never written) → NOT VERIFIED",
    latest_change: c
      ? { field: c.field.value, from: c.previous_value.value, to: c.new_value.value, block: c.change_block.value.toString(), tx: c.tx_hash.value, by: c.detected_by.value }
      : "none",
  };
});

if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else {
  console.log(`Arkiv block ${head}: ${rows.length} monitored contract(s)`);
  for (const r of rows) console.log(JSON.stringify(r, null, 2));
}
