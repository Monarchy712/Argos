# Arkiv schema

Argos writes eight entity types to Arkiv's **Rabdi** testnet (chain ID 7794095) with
`@arkiv-network/sdk@1.0.1`. Source of truth: [`packages/core/src/arkivSchemas.ts`](../packages/core/src/arkivSchemas.ts).
All schemas are **named** (`dg_*`), so every entity carries an indexed `arkiv.schema` tag.

Why each is shaped this way, and which Arkiv feature shows up on screen:
[`how-you-use-arkiv.md`](how-you-use-arkiv.md).

## Owners (trusted creators)

Anyone can write an entity with a `dg_*` tag, so **every read filters on `$creator`**
(`.createdBy(...)`) against two wallets, hard-coded in
[`packages/core/src/trust.ts`](../packages/core/src/trust.ts):

| Wallet | Address | Writes |
| --- | --- | --- |
| writer | `0x623EdFf351EB13aCCFc56cBf541eE4D45BDADCf4` | `dg_baseline`, `dg_descriptor`, `dg_deployment`, `dg_change_note`, `dg_recovery` |
| watcher | `0x8a883182b488cE04f08D348C64d9AC8EecACF2Bf` | `dg_current_state`, `dg_latest_change`, `dg_watcher_health` |

The watcher process holds only the watcher key. It reads baselines by the writer's public address,
so a compromised watcher can't move a baseline.

## Entities

Types are SDK column types; ⓘ = indexed (filterable). Hashes are `str` (`0x` + 64 hex), not `key`,
because the SDK defines `key` as a reference to another entity.

### `dg_baseline` — trust anchor per monitored contract (writer)
| attribute | type | meaning |
| --- | --- | --- |
| `chain_id` ⓘ | u64 | EVM chain of the monitored contract |
| `address` ⓘ | addr | monitored contract (the proxy) |
| `proxy_kind` ⓘ | str | `eip1967` / `beacon` / `diamond` / `safe` / `none` |
| `implementation`, `admin`, `beacon` | addr | values when baselined |
| `implementation_codehash`, `facets_hash` | str | keccak of impl bytecode; diamond facets hash |
| `code_identity` ⓘ | str | one hash over all of the above, compared for equality |
| `descriptor_hash` ⓘ | str | ERC-8176 hash of the ERC-7730 descriptor in force |
| `swarm_ref` | str | Swarm reference of that descriptor ("" in baselines written before the Swarm upload; the `dg_descriptor` row with the same `descriptor_hash` carries it) |
| `baseline_block`, `baselined_at` | u64 | block / unix time |
| `rebaseline_reason`, `previous_baseline_key` | str | audit trail of rebaselines |

### `dg_current_state` — liveness + current view (watcher)
Same `chain_id`, `address` and identity columns as the baseline, plus:
| attribute | type | meaning |
| --- | --- | --- |
| `matches_baseline` ⓘ | bool | `code_identity == baseline.code_identity` |
| `ever_changed_since_baseline` ⓘ | bool | sticky; A→B→A stays true, only a rebaseline clears it |
| `checked_block`, `checked_at` | u64 | last slot read |
| `last_scanned_block` | u64 | event cursor |
| `detection` | str | `event+slot` or `slot-only` |
| `baseline_key` | str | baseline it was compared to |

### `dg_latest_change` — newest detected change (watcher)
| attribute | type | meaning |
| --- | --- | --- |
| `chain_id` ⓘ, `address` ⓘ | u64, addr | contract |
| `field` ⓘ | str | `implementation` / `admin` / `beacon` / `facets` / `codehash` |
| `previous_value`, `new_value` | str | 0x-hex |
| `change_block` | u64 | |
| `tx_hash` | str | empty when the change was found by a slot read |
| `detected_at` | u64 | unix time |
| `detected_by` ⓘ | str | `event` or `slot` |

### `dg_descriptor` — one per registry file (writer, importer) — **771 rows live**
| attribute | type | meaning |
| --- | --- | --- |
| `descriptor_hash` ⓘ | str | ERC-8176 hash of the resolved descriptor ("" for include files) |
| `registry_path` ⓘ | str | e.g. `registry/aave/calldata-lpv3.json` |
| `registry_commit` ⓘ | str | last registry commit the file was seen in (40 hex) |
| `entity_dir` ⓘ | str | protocol folder (`aave`, `kiln`, …; `ercs` for shared token descriptors) |
| `kind` ⓘ | str | `calldata` / `eip712` / `include` |
| `file_sha` | str | keccak256 of the raw file bytes as GitHub serves them |
| `attestation` ⓘ | str | `valid` (an auditor signs exactly this hash) / `stale` (signs other content) / `none` |
| `storage_mode` ⓘ | str | `swarm` for the 746 calldata/EIP-712 descriptors (the resolved JCS bytes are on Swarm); `registry` for the 22 include files (already merged into the resolved descriptors) |
| `swarm_ref` | str | 64-hex **unencrypted** Swarm reference of the resolved descriptor's JCS bytes; `keccak256(bytes) == descriptor_hash`. Never an encrypted (128-hex) reference, which would embed its key in a public entity. See [swarm.md](swarm.md). |
| `size_bytes`, `schema_version`, `owner_name`, `imported_at` | u64 / str | metadata |

### `dg_deployment` — one per (chain, address, descriptor) (writer, importer) — **2,678 rows live**
`chain_id` ⓘ u64, `address` ⓘ addr, `descriptor_hash` ⓘ str, `registry_commit` ⓘ str,
`proxy_kind` ⓘ str (`eip1967` / `beacon` / `diamond` / `safe` / `none` / `no-code` / `unknown` for
mainnet; `unchecked` for other chains), `monitored` ⓘ bool (a baseline exists).

### `dg_change_note` — what a model said changed between two implementations (writer)

Written when the watcher detects an implementation move, by
[`watcher/src/explain.ts`](../watcher/src/explain.ts). The sentences themselves are **not here**:
an Arkiv `str` caps at 128 bytes, so the text goes to Swarm and this row carries its hash plus the
facts. This row never carries a verdict.

| attribute | type | meaning |
| --- | --- | --- |
| `chain_id` ⓘ, `address` ⓘ | u64, addr | the monitored proxy |
| `from_implementation`, `to_implementation` | addr | the two implementations compared |
| `change_block` | u64 | the block the change was detected at; with the pair above it identifies one change, so a retry never double-spends a 0G call |
| `summary_hash` ⓘ | str | keccak256 of the summary bytes on Swarm. The browser renders the text only if it re-hashes to this |
| `summary_swarm_ref` | str | 64-hex Swarm reference of the summary bytes |
| `selectors_added`, `selectors_removed` | u64 | counts from the PUSH4 diff; the selectors themselves are in the Swarm bytes |
| `same_surface` ⓘ | bool | true when both implementations expose identical selectors — the case that matters most for clear signing |
| `model` ⓘ | str | the 0G model that produced the text |
| `zerog_request_id` ⓘ | str | the `x_0g_trace.request_id` of the inference run, so the claim is attributable |
| `zerog_provider` | str | the 0G provider address that served it |
| `cost_usd_micro` | u64 | billed cost in micro-USD, from `x_0g_trace.billing` |
| `generated_at` | u64 | unix seconds |

### `dg_watcher_health` — the watcher's heartbeat, one row per chain (watcher)

Liveness as its own entity rather than something inferred from rows disappearing. See the expiry
section below for why this exists. Written by
[`watcher/src/health.ts`](../watcher/src/health.ts); read by `scripts/show-arkiv.ts`.

| attribute | type | meaning |
| --- | --- | --- |
| `chain_id` ⓘ | u64 | the chain this heartbeat covers |
| `last_cycle_at` ⓘ | u64 | unix seconds of the last completed cycle. **Monitoring freshness is measured from this** |
| `last_scanned_block` | u64 | last block whose change events were fully scanned — the replay checkpoint |
| `cycles` | u64 | cycles completed since this process started |
| `startup_gap_blocks` | u64 | blocks behind head when the process started, i.e. the downtime it replayed |
| `downtime_seconds` ⓘ | u64 | seconds between the previous cycle and this process starting; 0 on a first run |
| `mode` ⓘ | str | `normal` / `recovering` (gap < 24 h) / `disaster` (gap > 24 h) |
| `monitored`, `failed_reads` | u64 | contracts covered by the last cycle, and how many slot reads failed |

### `dg_recovery` — provenance when an expired entity is reconstructed (writer)

A reconstructed entity necessarily gets a new key, so this row is the bridge between the key that
was lost and the key that replaced it. Written by
[`watcher/src/recover.ts`](../watcher/src/recover.ts).

`old_entity_key` ⓘ str, `new_entity_key` ⓘ str (`""` if reconstruction produced no entity),
`entity_schema` ⓘ str, `source_block` u64 + `source_tx` str (the Arkiv block and transaction the
payload was recovered from), `original_created_block` u64, `payload_hash` ⓘ str (keccak256 over the
recovered attribute set, so a reader can check the reconstruction), `status` ⓘ str
(`reconstructed` / `verified` / `failed` — never `verified` until the new row has been read back),
`attributes` u64, `detail` str, `recovered_at` u64.

## Queried fields

| Who | Query |
| --- | --- |
| Web app (on load, one bulk read each) | all `dg_baseline` by writer; all `dg_current_state` and `dg_latest_change` by watcher. Filtered client-side by contract, so Arkiv doesn't learn which contract a user cares about. |
| Watcher (each cycle) | all `dg_baseline` by writer (the set it monitors) |
| Watcher (start / after an expiry) | `$key`, `chain_id`, `address`, `$expiresAt` and the newness timestamp of its own `dg_current_state` / `dg_latest_change`, so the newest row wins if a duplicate exists |
| Watcher (start) | its own `dg_watcher_health` by `chain_id`, to recover the checkpoint and classify downtime |
| `scripts/show-arkiv.ts` | `dg_watcher_health` by watcher (liveness per chain), then baselines, current state and latest change |
| Web app, Investigate tab | `dg_change_note` by `chain_id` + `address` from the bulk read → `summary_swarm_ref` + `summary_hash` → `GET {gateway}/bytes/{ref}`, keccak must equal `summary_hash` |
| `rebaseline` | `dg_baseline` where `chain_id` + `address`, by writer |
| `renew` | `$expiresAt < head + 30 days` per schema, by owner |
| Web app, Check | whole mirror (`dg_descriptor` + `dg_deployment`) by writer, paged, once per session; fallback: one contract's rows (shown on screen) |
| Web app, Browse | `dg_deployment` by `chain_id` / `proxy_kind` / `monitored`; `dg_descriptor` by `entity_dir` / `kind`, then deployments by OR of `descriptor_hash` |
| Swarm step (`npm run swarm -w importer`) | all of its own `dg_descriptor` rows (`registry_path`, `descriptor_hash`, `storage_mode`, `swarm_ref`) to find rows not yet on Swarm; then patches `swarm_ref` + `storage_mode` |
| Web app, Check (descriptor fetch) | `swarm_ref` + `descriptor_hash` from the cached mirror read → `GET {gateway}/bytes/{swarm_ref}`, keccak must equal `descriptor_hash` |
| `scripts/query-mirror.ts` | `dg_descriptor` by `attestation` / `entity_dir`; `dg_deployment` by `chain_id` + `address` |
| Importer | all of its own `dg_descriptor` / `dg_deployment` rows (to plan creates vs patches), all baselines (for `monitored`) |

## Expiry, freshness and liveness — three different things

Arkiv max lifetime is 7,884,000 blocks ≈ 182.5 days (2 s blocks), measured from the block a create
or extension lands in; an extension resets the window.

**Every Argos entity is created with `ExpirationTime.max()`**, and
`npm run renew -w watcher` extends anything with under 30 days left (a patch alone never moves
expiry, so importer re-runs don't renew).

| Entity | Expiry | Renewal |
| --- | --- | --- |
| all eight `dg_*` schemas | `ExpirationTime.max()` (~182 days) | `npm run renew -w watcher` below 30 days remaining |

**This is a change from the earlier design, and it is the one claim in this repo most worth reading
carefully**, because it is load-bearing for "a dead watcher can never show a stale green".

`dg_current_state` used to expire after **10 minutes**, so a stopped watcher showed up as its rows
*disappearing* from every query. That was a correct signal, and lossy: it conflated four separate
things — how long a record survives to be read (expiry), whether the process is running
(heartbeat), how far it has scanned (checkpoint), and whether what it last said is recent enough to
rely on (freshness). Binding the last three to the first threw away every observation older than
ten minutes, which is exactly the history that change auditing and disaster recovery need.

They are now separate:

| Concern | Mechanism | Value |
| --- | --- | --- |
| Retention | `$expiresAt` | ~182 days, renewed on a sliding window |
| Freshness | `dg_current_state.checked_at` vs now | stale after **300 s** (`EXPIRY.freshnessSeconds`) |
| Liveness | `dg_watcher_health.last_cycle_at` | per chain, with `mode` and `failed_reads` |
| Checkpoint | `dg_watcher_health.last_scanned_block` | the replay point after downtime |

**The user-visible behaviour is the same, and arrives sooner:** stop the watcher and every
monitored contract reads **NOT VERIFIED** within **5 minutes** (was 10), with the reason shown
("No live watcher record"). `computeStatus`
([`packages/core/src/status.ts`](../packages/core/src/status.ts)) already measured `checked_at`;
it is now the only thing that decides a badge. What is new is that the trail survives to be read
afterwards, and that `scripts/show-arkiv.ts` can state a dead watcher directly instead of leaving
a reader to infer it from missing rows.

Expiry still carries one user-visible guarantee: we cannot renew rows after we stop paying
attention, so the dataset is self-limiting rather than authoritative forever — a 182-day promise,
not a 10-minute one.

Updates use one `executeBatch` per cycle, pairing a patch with an extension only when a row's
window is actually running down (extending every row every cycle would be thousands of operations
a day to move an expiry months away). A rebaseline creates the new baseline and deletes the old one
in the same transaction.

## Run a query

```bash
node --env-file-if-exists=.env scripts/show-arkiv.ts
```
Read-only and works without keys. It prints the **watcher's liveness per chain** from
`dg_watcher_health` (`mode`, `last_cycle_age_s`, `last_scanned_block`, `failed_reads` and a `live`
boolean against the 300 s freshness line), then each monitored contract's baseline, current state
and latest change with the verdict the browser would show — `VERIFIED`, `CHANGE DETECTED`, or
`NOT VERIFIED` with the reason.
