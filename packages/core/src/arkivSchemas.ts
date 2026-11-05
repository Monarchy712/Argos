/**
 * Arkiv entity schemas (see docs/ARCHITECTURE.md §2.3 and arkiv/schema.md).
 *
 * Named schemas tag each entity with an indexed `arkiv.schema` attribute, so queries through
 * them only see DriftGuard rows. Readers must still filter on `$creator` (trust.ts): anyone can
 * write an entity that carries our tag.
 *
 * 32-byte hashes are stored as `str` (0x + 64 hex = 66 bytes, under the 128-byte str limit)
 * rather than `key`, because the SDK defines `key` as a reference to another entity.
 */
import { addr, bool, defineSchema, str, u64 } from "@arkiv-network/sdk/schema";

const contract = {
  chain_id: u64().indexed(),
  address: addr().indexed(),
};

const identity = {
  proxy_kind: str().indexed(),
  implementation: addr(),
  implementation_codehash: str(),
  admin: addr(),
  beacon: addr(),
  facets_hash: str(),
  code_identity: str().indexed(),
};

/** Trust anchor per monitored contract. Writer wallet. Replaced only by `rebaseline`. */
export const BaselineSchema = defineSchema("dg_baseline", {
  ...contract,
  ...identity,
  descriptor_hash: str().indexed(),
  swarm_ref: str(),
  baseline_block: u64(),
  baselined_at: u64(),
  rebaseline_reason: str(),
  previous_baseline_key: str(),
});

/** Liveness + current view. Watcher wallet. Short expiry, rewritten every 120 s or on change. */
export const CurrentStateSchema = defineSchema("dg_current_state", {
  ...contract,
  ...identity,
  matches_baseline: bool().indexed(),
  ever_changed_since_baseline: bool().indexed(),
  checked_block: u64(),
  checked_at: u64(),
  last_scanned_block: u64(),
  detection: str(),
  baseline_key: str(),
});

/** Newest detected change per contract. Watcher wallet. Replaced on a newer change. */
export const LatestChangeSchema = defineSchema("dg_latest_change", {
  ...contract,
  field: str().indexed(),
  previous_value: str(),
  new_value: str(),
  change_block: u64(),
  tx_hash: str(),
  detected_at: u64(),
  detected_by: str().indexed(),
});

/** One per registry descriptor file (mirror). Writer wallet. */
export const DescriptorSchema = defineSchema("dg_descriptor", {
  descriptor_hash: str().indexed(),
  registry_path: str().indexed(),
  registry_commit: str().indexed(),
  entity_dir: str().indexed(),
  kind: str().indexed(),
  swarm_ref: str(),
  storage_mode: str().indexed(),
  size_bytes: u64(),
  file_sha: str(),
  schema_version: str(),
  owner_name: str(),
  imported_at: u64(),
});

/** One per (chain, address, descriptor) deployment listed in a descriptor. Writer wallet. */
export const DeploymentSchema = defineSchema("dg_deployment", {
  ...contract,
  descriptor_hash: str().indexed(),
  registry_commit: str().indexed(),
  proxy_kind: str().indexed(),
  monitored: bool().indexed(),
});

/** Expiry policy in seconds (ARCHITECTURE §2.4). */
export const EXPIRY = {
  /** ≈ 180 days, under the 182.5-day max lifetime. */
  longSeconds: 180 * 24 * 3600,
  /** current_state: a dead watcher shows as NOT VERIFIED once this lapses. */
  currentStateSeconds: 10 * 60,
  /** Renew long-lived entities when fewer than this many seconds remain. */
  renewBelowSeconds: 30 * 24 * 3600,
} as const;
