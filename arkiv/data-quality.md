# Arkiv — data quality

Argos mirrors the **EF ERC-7730 clear-signing registry**
([ethereum/clear-signing-erc7730-registry](https://github.com/ethereum/clear-signing-erc7730-registry),
**CC0-1.0**, not Sourcify data) into Arkiv, and adds per-deployment proxy classification and
upgrade monitoring. This page covers what's in the mirror, how each row is checked, how it stays
current, and how anyone can check it.

## What's mirrored

At registry commit `ef582c2f03bfbd062b7e3889b55dd3b45c3d5494`:

| Entity | Rows | One per | Key fields |
| --- | --- | --- | --- |
| `dg_descriptor` | **771** = 620 calldata + 129 EIP-712 + 22 include files | registry file (`registry/**`, `ercs/**`; tests and `sigs/` excluded) | `descriptor_hash` (ERC-8176), `file_sha`, `registry_path`, `registry_commit`, `entity_dir`, `kind`, `attestation`, `storage_mode` = `swarm` + `swarm_ref` (746 descriptors; content on Swarm, see [swarm.md](swarm.md)) or `registry` (22 include files) |
| `dg_deployment` | **2,678** | (chain, contract address, descriptor hash) from each descriptor's `context.contract.deployments` / `context.eip712.deployments` | `chain_id`, `address`, `descriptor_hash`, `proxy_kind`, `monitored`, `registry_commit` |

All rows are written by the writer wallet `0x623EdFf351EB13aCCFc56cBf541eE4D45BDADCf4`; readers
filter on it with `.createdBy(...)`.

## Can people filter it the way they search for it?

The questions people actually ask of the registry, and the Arkiv query that answers each. Every
field below is indexed (ⓘ in [schema.md](schema.md)), and each is reachable either as one
read-only command or from the app's **Add Contract** inspection, which runs the deployment and
descriptor lookups against the mirror and shows what it found:

| People ask | Arkiv query (writer's rows only) | Try it |
| --- | --- | --- |
| "Is there a descriptor for this contract?" (what a wallet asks before signing) | `dg_deployment WHERE chain_id = 1 AND address = 0x8787…` → `dg_descriptor WHERE descriptor_hash = …` | `node scripts/query-mirror.ts deployments 1 0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2` |
| "Which attestations no longer match the file?" | `dg_descriptor WHERE attestation = "stale"` | `node scripts/query-mirror.ts stale` |
| "Everything from one protocol" | `dg_descriptor WHERE entity_dir = "safe"` | `node scripts/query-mirror.ts protocol safe` |
| "Which deployments on chain X are upgradeable proxies?" | `dg_deployment WHERE chain_id = 1 AND proxy_kind = "beacon"` | `node scripts/query-mirror.ts proxies 1 beacon` |
| "Which descriptors does Argos monitor?" | `dg_deployment WHERE monitored = true` | `node scripts/show-arkiv.ts` (every monitored contract) |
| "Which EIP-712 descriptors exist?" | `dg_descriptor WHERE kind = "eip712"` | `node scripts/query-mirror.ts kind eip712` |
| "Has the code behind this descriptor changed?" | `dg_current_state WHERE chain_id = … AND address = …` (watcher's rows) | `node scripts/show-arkiv.ts` |

Not filterable by design: free text (owner names are stored but not indexed), and proxy kind for
non-mainnet chains (`unchecked` rather than guessed).

## How each row is checked at import

1. **Raw bytes:** `file_sha = keccak256(bytes exactly as GitHub serves them)`. The importer refuses
   any file containing CR bytes. A Windows checkout with `core.autocrlf=true` once changed every
   hash, and the browser's integrity check caught it.
2. **ERC-8176 descriptor hash, computed twice:** `includes` are resolved with the library's
   `mergeDescriptors`, then the hash is computed by **our** RFC 8785 JCS (`canonicalize@5.1.0`) + keccak256
   **and** by `@ethereum-sourcify/clear-signing`'s `computeDescriptorHash`. **Any mismatch aborts the
   import.** Result: 746/746 descriptors equal.
3. **Against auditors:** for each descriptor with attestations in `sigs/`, the hash the auditor signed
   (`sig.message.data`) is compared with ours. **164 of 167 match exactly.** The other 3 are recorded
   as `attestation = "stale"` (the attestation signs different content than the current file):
   `registry/safe/calldata-SafeMigration-1.5.0.json`, `registry/safe/eip712-Safe-Multisig.json`,
   `registry/walletconnect/calldata-wct.json`. That's a genuine registry finding: wallets enforcing
   ERC-8176 attestations would reject these descriptors until they're re-attested.
4. **Arkiv limits:** paths are checked against the 128-byte `str` limit, and free text (owner names)
   is truncated by UTF-8 bytes.
5. **Proxy kind (mainnet):** each chain-1 deployment is classified on-chain (EIP-1967 implementation
   slot, beacon slot + `implementation()`, diamond loupe `facets()`, Safe singleton) at one pinned
   block. Other chains are marked `unchecked` rather than guessed.

## How it stays current

**Is it up to date now?** Yes. The mirror's commit `ef582c2` is the registry's `master` HEAD as of
Nov 6, 08:55 IST. Check it yourself: `git ls-remote https://github.com/ethereum/clear-signing-erc7730-registry master`
should print `ef582c2f…`, and `node scripts/query-mirror.ts stale` shows `@ef582c2` on every row. If
upstream moves, re-running the importer on the new commit patches unchanged rows to it and adds
new ones (below). Today the re-run is manual; running it on every upstream push (a scheduled job)
is the obvious next step.

- **Re-runnable and idempotent.** The importer first reads every row the writer already published,
  then creates only missing rows and patches changed ones. A second run on the same commit plans
  **0 creates**. See [Verification](#verification-run) below.
- **New registry versions never overwrite.** A changed file gets a new `file_sha` and
  `descriptor_hash`, and therefore a new row. The old row stays as history, with `registry_commit`
  = the last commit it was seen in. Rows still present in a new pin are patched to that commit.
- **Mutable facts are patched in place:** attestation status (when auditors add or refresh
  `sigs/`), proxy kind, `monitored` (when a baseline is added), protocol folder.
- **Resumable.** Writes go in `executeBatch` transactions of 20 ops (halved automatically on HTTP 413).
  An interrupted run resumes from whatever is on Arkiv.
- **Content on Swarm.** `npm run swarm -w importer` uploads the resolved bytes of any descriptor
  row not yet on Swarm and records `swarm_ref`, so new registry versions get content too. Each upload
  is read back and keccak-checked against `descriptor_hash` before the ref is written.
- **Renewal.** All mirror rows use the maximum lifetime (~182 days); `npm run renew -w watcher`
  extends any with less than 30 days left.

### Re-run it

```bash
git -c core.autocrlf=false clone https://github.com/ethereum/clear-signing-erc7730-registry .cache/registry
git -C .cache/registry checkout ef582c2f03bfbd062b7e3889b55dd3b45c3d5494
npm run import -w importer -- ../.cache/registry --dry   # plan only (needs no key)
npm run import -w importer -- ../.cache/registry         # write (writer key in .env)
npm run verify -w importer -- ../.cache/registry         # client-side verification, no key
```

## Verification run

2026-11-06, Rabdi ([import log](../docs/test-runs/import-rabdi.txt), [verify log](../docs/test-runs/mirror-verify.txt)):

| Step | Result |
| --- | --- |
| Import run 1 | 3,443 creates in 173 batches, 0 failures, 17.3 min, **1.65 tGLM** (~0.00048 tGLM per row) |
| Import run 2 (same commit) | plan: **0 creates**, 6 patches (a protocol-folder fix for `ercs/` rows), 3,437 unchanged |
| Import run 3 (dry) | plan: **0 creates, 0 patches**, 3,443 unchanged |
| Client read, counts (re-run 2026-11-07) | `dg_descriptor` 620 / 129 / 22 = registry; `dg_deployment` 2,678 = registry — **MIRROR VERIFY: PASS** (3,449 rows read in 10 s) |
| 10 random descriptors vs GitHub raw @ `ef582c2` | **10/10**: `keccak256(GitHub bytes) == file_sha` and `computeDescriptorHash(resolved from GitHub) == descriptor_hash` |
| Stale attestations on Arkiv | exactly the 3 listed above |
| Re-verify, Nov 6 ~08:55 IST | counts match again, **10/10** new random spot-checks pass; upstream `master` is still `ef582c2`, so the mirror is current |

## One runnable query

All attested descriptors whose attestation no longer matches their content, read straight from
Arkiv (no keys):

```bash
node --input-type=module -e '
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { eq } from "@arkiv-network/sdk/query";
import { http } from "viem";
import { DescriptorSchema, TRUSTED_CREATORS } from "@driftguard/core";
const c = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http() });
const r = await c.select({ registry_path: true, descriptor_hash: true, registry_commit: true })
  .from(DescriptorSchema).where(eq("attestation", "stale")).createdBy(TRUSTED_CREATORS.writer).fetch();
for (const e of r.entities) console.log(e.registry_path.value, e.descriptor_hash.value);'
```

More queries, each printing the Arkiv query it runs and an explorer link per entity:

```bash
node scripts/query-mirror.ts stale                                              # the 3 stale attestations
node scripts/query-mirror.ts deployments 1 0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2   # descriptors bound to one contract
node scripts/query-mirror.ts protocol safe                                      # one registry folder
```

Example entity: [stale `registry/safe/calldata-SafeMigration-1.5.0.json`](https://rabdi.explorer.arkiv.network/entity/0xdd73f42bcf36a2c51aee264212bb8ef041530ecab5254399da923dfee8e8b3e3).
