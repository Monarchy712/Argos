# Arkiv schema

Argos writes five entity types to Arkiv's **Rabdi** testnet (chain ID 7794095) with
`@arkiv-network/sdk@1.0.1`. Source of truth: [`packages/core/src/arkivSchemas.ts`](../packages/core/src/arkivSchemas.ts).
All schemas are **named** (`dg_*`), so every entity carries an indexed `arkiv.schema` tag.

## Owners (trusted creators)

Anyone can write an entity with a `dg_*` tag, so **every read filters on `$creator`**
(`.createdBy(...)`) against two wallets, hard-coded in
[`packages/core/src/trust.ts`](../packages/core/src/trust.ts):

| Wallet | Address | Writes |
| --- | --- | --- |
| writer | `0x623EdFf351EB13aCCFc56cBf541eE4D45BDADCf4` | `dg_baseline`, `dg_descriptor`, `dg_deployment` |
| watcher | `0x8a883182b488cE04f08D348C64d9AC8EecACF2Bf` | `dg_current_state`, `dg_latest_change` |

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

### `dg_descriptor` — one per registry file (writer, importer) — **768 rows live**
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

### `dg_deployment` — one per (chain, address, descriptor) (writer, importer) — **2,675 rows live**
`chain_id` ⓘ u64, `address` ⓘ addr, `descriptor_hash` ⓘ str, `registry_commit` ⓘ str,
`proxy_kind` ⓘ str (`eip1967` / `beacon` / `diamond` / `safe` / `none` / `no-code` / `unknown` for
mainnet; `unchecked` for other chains), `monitored` ⓘ bool (a baseline exists).

## Queried fields

| Who | Query |
| --- | --- |
| Web app (on load, one bulk read each) | all `dg_baseline` by writer; all `dg_current_state` and `dg_latest_change` by watcher. Filtered client-side by contract, so Arkiv doesn't learn which contract a user cares about. |
| Watcher (each cycle) | all `dg_baseline` by writer (the set it monitors) |
| Watcher (start / after an expiry) | `$key`, `chain_id`, `address` of its own `dg_current_state` / `dg_latest_change` |
| `rebaseline` | `dg_baseline` where `chain_id` + `address`, by writer |
| `renew` | `$expiresAt < head + 30 days` per schema, by owner |
| Web app, Check | whole mirror (`dg_descriptor` + `dg_deployment`) by writer, paged, once per session; fallback: one contract's rows (shown on screen) |
| Web app, Browse | `dg_deployment` by `chain_id` / `proxy_kind` / `monitored`; `dg_descriptor` by `entity_dir` / `kind`, then deployments by OR of `descriptor_hash` |
| Importer | all of its own `dg_descriptor` / `dg_deployment` rows (to plan creates vs patches), all baselines (for `monitored`) |

## Expiry

Arkiv max lifetime is 7,884,000 blocks ≈ 182.5 days (2 s blocks).

| Entity | Expiry | Renewal |
| --- | --- | --- |
| `dg_baseline`, `dg_descriptor`, `dg_deployment`, `dg_latest_change` | `ExpirationTime.max()` (~182 days) | `npm run renew -w watcher` extends anything with < 30 days left; re-running the importer patches rows still in the registry |
| `dg_current_state` | **10 minutes**, extended on every write (every 120 s, or at once on change) | none on purpose: if the watcher stops, the row expires and clients show **NOT VERIFIED** |

Updates use one `executeBatch` per cycle. A patch never moves expiry, so each current_state
rewrite pairs a patch with an extension. A rebaseline creates the new baseline and deletes the old
one in the same transaction.

## Run a query

```bash
node --env-file-if-exists=.env scripts/show-arkiv.ts
```
Read-only and works without keys. It prints each monitored contract's baseline, current state
(or NOT VERIFIED if expired) and latest change.
