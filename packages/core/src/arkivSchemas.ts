/**
 * Arkiv entity schemas (see docs/ARCHITECTURE.md §2.3 and arkiv/schema.md).
 *
 * Named schemas tag each entity with an indexed `arkiv.schema` attribute, so queries through
 * them only see Argos rows. Readers must still filter on `$creator` (trust.ts): anyone can
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
  /** "valid": an auditor attestation in sigs/ signs exactly this descriptor_hash; "stale": the
   *  registry has an attestation but for different content; "none": no attestation. */
  attestation: str().indexed(),
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

/**
 * A plain-language description of what changed between two implementations, produced by a model
 * on 0G Private Computer when a change is detected. Writer wallet.
 *
 * The description itself lives on **Swarm** (`summary_swarm_ref`), because an Arkiv `str` caps at
 * 128 bytes — the same split Argos already uses for descriptors: content on Swarm, facts and the
 * hash on Arkiv. `summary_hash` is keccak256 of those bytes, so the browser verifies the text it
 * renders exactly as it verifies a descriptor, and a gateway cannot substitute different words.
 *
 * This row never carries a verdict. It records what changed about the call surface, which model
 * said so, and the 0G request id that produced it, so the claim is attributable and re-checkable.
 * Argos does not decide whether a change is safe, and neither does the model.
 */
export const ChangeNoteSchema = defineSchema("dg_change_note", {
  ...contract,
  from_implementation: addr(),
  to_implementation: addr(),
  change_block: u64(),
  /** keccak256 of the summary bytes on Swarm (0x + 64 hex). */
  summary_hash: str().indexed(),
  summary_swarm_ref: str(),
  /** Counts only; the selectors themselves are in the summary bytes. */
  selectors_added: u64(),
  selectors_removed: u64(),
  /** True when the call surface is identical and only the code behind it changed. */
  same_surface: bool().indexed(),
  /** Provenance of the claim, so a reader can go and check it. */
  model: str().indexed(),
  zerog_request_id: str().indexed(),
  zerog_provider: str(),
  cost_usd_micro: u64(),
  generated_at: u64(),
});

/**
 * Liveness of the watcher itself, independent of any one contract. Watcher wallet.
 *
 * This exists because entity expiry, a watcher heartbeat, the last block actually scanned and
 * "is the data fresh" are four different things, and the system used to conflate the first two:
 * `dg_current_state` expired after ten minutes, so a dead watcher was inferred from rows
 * *disappearing*. That worked, but it threw away the history and said nothing about why. A
 * heartbeat says it directly, and survives long enough to be read after the fact.
 */
export const WatcherHealthSchema = defineSchema("dg_watcher_health", {
  chain_id: u64().indexed(),
  /** Last block whose change events were fully scanned — the replay checkpoint. */
  last_scanned_block: u64(),
  /** unix seconds of the last completed cycle. Monitoring freshness is measured from this. */
  last_cycle_at: u64().indexed(),
  /** Cycles completed since this process started. */
  cycles: u64(),
  /** Blocks that were behind head when the process started, i.e. the downtime gap it replayed. */
  startup_gap_blocks: u64(),
  /** Seconds between the previous cycle and this process starting. 0 on a first run. */
  downtime_seconds: u64().indexed(),
  /** "normal" | "recovering" | "disaster" — see watcher/src/health.ts for what decides. */
  mode: str().indexed(),
  /** How many contracts this chain's last cycle covered. */
  monitored: u64(),
  /** Contracts whose slot read failed in the last cycle. */
  failed_reads: u64(),
});

/**
 * An Arkiv entity reconstructed from historical blocks after the original expired.
 *
 * The recreated entity necessarily has a new key, so this row is the bridge: it records which key
 * was lost, which key replaced it, and where the payload was recovered from, so provenance
 * survives the gap. Writer wallet. See watcher/src/recover.ts.
 */
export const RecoverySchema = defineSchema("dg_recovery", {
  /** The key the expired entity had. */
  old_entity_key: str().indexed(),
  /** The key of the entity created to replace it, or "" when reconstruction produced no entity. */
  new_entity_key: str().indexed(),
  /** The schema the original carried, e.g. "dg_baseline". */
  entity_schema: str().indexed(),
  /** Arkiv block and transaction the original payload was recovered from. */
  source_block: u64(),
  source_tx: str(),
  /** Arkiv block the original was created at, as the historical event recorded it. */
  original_created_block: u64(),
  /** keccak256 over the recovered attribute set, so a reader can check the reconstruction. */
  payload_hash: str().indexed(),
  /** "reconstructed" | "verified" | "failed" — never "verified" until the new row has been read back. */
  status: str().indexed(),
  /** How many attributes were recovered. */
  attributes: u64(),
  detail: str(),
  recovered_at: u64(),
});

/**
 * Arkiv block time in seconds (the SDK's BLOCK_TIME). Needed wherever an `$expiresAt` block has
 * to be turned into wall-clock time, or a duration into blocks.
 */
export const ARKIV_BLOCK_SECONDS = 2;

/**
 * Expiry and renewal policy, in seconds.
 *
 * WHY EVERYTHING IS NOW LONG-LIVED. The installed SDK caps an entity at `MAX_LIFETIME` =
 * 7,884,000 blocks ≈ 182.5 days from the block the create or extension lands in
 * (node_modules/@arkiv-network/sdk/src/consts.ts), and an extension resets that window. So the
 * longest retention available is about six months per extension, renewed on a sliding window —
 * not one month, which was the working assumption.
 *
 * `dg_current_state` used to expire after ten minutes, deliberately: a vanished row meant a dead
 * watcher. That coupled two unrelated things. Monitoring freshness is a property of
 * `checked_at` — which `computeStatus` already measures, and which is what turns a contract
 * NOT VERIFIED — while expiry decides how long the record survives to be *read*. Tying them
 * together threw away every observation older than ten minutes, which is exactly the history
 * disaster recovery needs. Current state is now long-lived too, and staleness still comes from
 * `checked_at`, so a stopped watcher reads NOT VERIFIED just as before while the trail survives.
 */
export const EXPIRY = {
  /** Every Argos entity is created with ExpirationTime.max(); this is what that comes to. */
  maxSeconds: 7_884_000 * 2,
  /** Renew when fewer than this many seconds remain — a third of the window. */
  renewBelowSeconds: 60 * 24 * 3600,
  /**
   * A watcher record older than this is stale, and its contract reads NOT VERIFIED. This is the
   * freshness line; it has nothing to do with when the entity expires.
   */
  freshnessSeconds: 300,
  /** @deprecated Kept so an older row's expiry still parses. Nothing writes a 10-minute expiry now. */
  currentStateSeconds: 10 * 60,
  /** @deprecated Superseded by `maxSeconds`; ExpirationTime.max() is what writes actually use. */
  longSeconds: 180 * 24 * 3600,
} as const;
