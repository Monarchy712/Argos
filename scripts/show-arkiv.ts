/**
 * Prints the watcher's liveness and every monitored contract's baseline, current_state and
 * latest_change from Arkiv, trusting only Argos's writer/watcher wallets — the same reads the web
 * app does. Read-only; works without any private key (keyless, or with ARKIV_ACCESS_KEY if set).
 *
 *   node --env-file-if-exists=.env scripts/show-arkiv.ts [--json]
 *
 * WHY THE HEARTBEAT IS PRINTED FIRST. Liveness used to be expressed through entity expiry:
 * `dg_current_state` lived ten minutes, so a dead watcher showed up as rows vanishing. Records are
 * long-lived now and freshness comes from `checked_at` instead (EXPIRY.freshnessSeconds), which
 * keeps the history a vanishing row used to destroy. That makes the heartbeat the thing a reader
 * has to look at to answer "is anyone still watching?", so this script reads `dg_watcher_health`
 * and derives the same verdict `computeStatus` gives the browser, rather than leaving the reader to
 * work it out from a timestamp.
 */
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http } from "viem";
import { BaselineSchema, CurrentStateSchema, EXPIRY, LatestChangeSchema, TRUSTED_CREATORS, WatcherHealthSchema } from "@driftguard/core";

const pub = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });
const [baselines, states, changes, health] = await Promise.all([
  pub.select().from(BaselineSchema).createdBy(TRUSTED_CREATORS.writer).limit(100).fetch(),
  pub.select().from(CurrentStateSchema).createdBy(TRUSTED_CREATORS.watcher).limit(100).fetch(),
  pub.select().from(LatestChangeSchema).createdBy(TRUSTED_CREATORS.watcher).limit(100).fetch(),
  pub.select().from(WatcherHealthSchema).createdBy(TRUSTED_CREATORS.watcher).limit(100).fetch(),
]);

const now = Math.floor(Date.now() / 1000);
const id = (r: { chain_id: { value: bigint }; address: { value: string } }) => `${r.chain_id.value}:${r.address.value.toLowerCase()}`;
const head = baselines.blockNumber;

/**
 * Newest row per contract — never the first one paged.
 *
 * A contract should hold one `dg_current_state`, and patching is what keeps it that way, but it
 * can hold two: on 2026-11-06 two watcher processes ran at once and each created a row for the
 * same Sepolia contract. Arkiv pages in `$key` order, which is unrelated to write time, so a
 * `.find()` here returned an arbitrary one of the pair — and the frozen one still claimed
 * `matches_baseline: true` for an implementation that had since changed. That is a false green,
 * the exact failure this project exists to prevent, so the newest observation wins, exactly as
 * the watcher (`watcher/src/arkivSink.ts`) and the browser (`web/src/lib/rows.ts`) both do.
 */
function newestBy<T>(rows: readonly T[], key: (r: T) => string, at: (r: T) => bigint): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const kept = m.get(k);
    if (!kept || at(r) > at(kept)) m.set(k, r);
  }
  return m;
}

const stateFor = newestBy(states.entities, id, (r) => r.checked_at.value);
const changeFor = newestBy(changes.entities, id, (r) => r.detected_at.value);
/** Reported rather than silently resolved: more rows than contracts means a duplicate writer. */
const duplicates = {
  dg_current_state: states.entities.length - stateFor.size,
  dg_latest_change: changes.entities.length - changeFor.size,
};

/** One heartbeat row per chain: is the process still cycling, and how far has it scanned? */
const watcher = health.entities
  .map((h) => ({
    chain_id: Number(h.chain_id.value),
    mode: h.mode.value,
    last_cycle_age_s: now - Number(h.last_cycle_at.value),
    last_scanned_block: h.last_scanned_block.value.toString(),
    cycles: Number(h.cycles.value),
    monitored: Number(h.monitored.value),
    failed_reads: Number(h.failed_reads.value),
    /** The freshness line, stated rather than left for the reader to apply to the age above. */
    live: now - Number(h.last_cycle_at.value) <= EXPIRY.freshnessSeconds,
  }))
  .sort((a, b) => a.chain_id - b.chain_id);

const rows = baselines.entities.map((b) => {
  const s = stateFor.get(id(b));
  const c = changeFor.get(id(b));
  const age = s ? now - Number(s.checked_at.value) : null;
  // The same three-way verdict the browser shows, derived from the same inputs. A stale record is
  // NOT VERIFIED, never a green badge nobody is backing.
  const verdict =
    !s || age === null ? "NOT VERIFIED (no watcher record)"
    : age > EXPIRY.freshnessSeconds ? `NOT VERIFIED (record is ${age}s old, stale after ${EXPIRY.freshnessSeconds}s)`
    : !s.matches_baseline.value ? "CHANGE DETECTED (differs from baseline)"
    : "VERIFIED (no change as of the block below)";
  return {
    contract: id(b),
    verdict,
    baseline: { key: b.$key, implementation: b.implementation.value, block: b.baseline_block.value.toString() },
    current: s
      ? {
          key: s.$key,
          implementation: s.implementation.value,
          matches_baseline: s.matches_baseline.value,
          ever_changed_since_baseline: s.ever_changed_since_baseline.value,
          checked_block: s.checked_block.value.toString(),
          checked_age_s: age,
          stale_after_s: EXPIRY.freshnessSeconds,
          expires_in_s: Number(s.$expiresAt - head) * 2,
        }
      : "none written → NOT VERIFIED",
    latest_change: c
      ? { field: c.field.value, from: c.previous_value.value, to: c.new_value.value, block: c.change_block.value.toString(), tx: c.tx_hash.value, by: c.detected_by.value }
      : "none",
  };
});

if (process.argv.includes("--json")) console.log(JSON.stringify({ watcher, duplicates, contracts: rows }, null, 2));
else {
  console.log(`Arkiv block ${head}: ${rows.length} monitored contract(s)`);
  console.log(`\nWatcher liveness (dg_watcher_health, stale after ${EXPIRY.freshnessSeconds}s):`);
  if (watcher.length === 0) console.log("  no heartbeat row — nothing is watching, so every contract below reads NOT VERIFIED");
  for (const w of watcher) console.log(`  ${JSON.stringify(w)}`);
  for (const [schema, n] of Object.entries(duplicates)) {
    if (n > 0) console.log(`  NOTE: ${n} extra ${schema} row(s) beyond one per contract — the newest observation is used; see arkiv/friction.md §6`);
  }
  console.log();
  for (const r of rows) console.log(JSON.stringify(r, null, 2));
}
