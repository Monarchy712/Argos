# Risk test report

Results of the risk tests from `docs/ARCHITECTURE.md`, newest first within each test. Raw run
output is committed under `docs/test-runs/`.

| Test | Status | Run output |
| --- | --- | --- |
| 3 — proxy detection | **PASS** on Sepolia (10/10) and local anvil | [sepolia](test-runs/test3-sepolia.txt) · [sepolia phase 2](test-runs/test3-sepolia-phase2.txt) · [local](test-runs/test3-local.txt) |
| 2 — Arkiv records | **PASS** (9/9, keyed run: 0×429; keyless run found the 429 cost limit) | [keyed](test-runs/test2-rabdi-keyed.txt) · [keyless](test-runs/test2-rabdi.txt) |
| E2E — watcher → Arkiv (Sepolia) | **PASS** (5/5 + expiry) | [e2e-arkiv-sepolia.txt](test-runs/e2e-arkiv-sepolia.txt) |
| 4 — Nym reads | screen built (Nym diagnostics → Run 20 reads); **not run yet** (needs a real browser on venue Wi-Fi) | — |
| 1 — Swarm | not started (by plan: postage depends on the Swarm booth) | — |

---

## Test 3 — Proxy upgrade detection

**Goal:** a watcher detects A→B and B→A upgrades of an OpenZeppelin TransparentUpgradeableProxy
via events **and** slot reads, `ever_changed_since_baseline` stays true after B→A, and a killed
watcher resumes from its cursor without missing a change.

**How to run:** `scripts/test3.sh local` (anvil) or `scripts/test3.sh sepolia`. The script uses the
watcher's file sink, so Test 3 is independent of Arkiv.

### Run 1 — local anvil, 2026-11-06 ~03:05 IST — PASS

Setup: anvil (1 s blocks), OZ v5.6.1 `TransparentUpgradeableProxy`, `DemoImplA` / `DemoImplB`,
watcher poll 3 s, write interval 6 s (scaled down from 60 s / 120 s for the test).

Sequence and results:

| Step | Result |
| --- | --- |
| Deploy ImplA, ImplB, proxy → ImplA; `rebaseline` | baseline = ImplA at deploy block |
| Watcher running; upgrade A→B | `change` logged, `by: "event"`, with tx hash |
| **Hard kill** (`kill -9`, no shutdown handler runs) | cursor file on disk at the last finished cycle |
| Upgrade B→A **while the watcher is down** | — |
| Restart watcher | `start` log shows `resumeFrom` = the cursor saved at kill time; the missed B→A event is found by re-scanning from there |
| Final `current_state` | implementation = ImplA (slot read, matches `cast storage`), `matches_baseline = true`, **`ever_changed_since_baseline = true`** |
| Final `latest_change` | B→A with its tx hash |
| Phase 2: new baseline, event scanning **disabled**, upgrade A→B | change detected `by: "slot"` (no tx hash), `matches_baseline = false` |

All 10 scripted checks pass (see the run output).

Also verified while building:
- **A1 closed:** OZ 5.6.1 `TransparentUpgradeableProxy` creates its own `ProxyAdmin(initialOwner)`,
  writes the EIP-1967 admin slot and emits `AdminChanged`. Upgrades go only through
  `ProxyAdmin.upgradeAndCall` (source: `contracts/lib/openzeppelin-contracts`, tag v5.6.1).
- **New finding:** OZ 5.6 `ERC1967Proxy` reverts with `ERC1967ProxyUninitialized()` when the init data is
  empty. The demo ImplA therefore has a one-shot `initialize(uint256)`.
- Foundry tests (`contracts/test/DemoProxy.t.sol`): slot constants, one `Upgraded` per upgrade emitted
  by the proxy, only the owner can upgrade, A/B codehashes differ. 4/4 pass.
- Engine unit tests (`watcher/test/engine.test.ts`): A→B, A→B→A in one cycle (the slot read alone
  would miss it, but the events catch it), A→B→A across cycles, slot-only detection, no-op
  upgrade, rebaseline reset, metamorphic codehash change. 8/8 pass, plus 3 core tests.

### Run 2 — Sepolia, 2026-11-06 ~03:30–03:42 IST — PASS (10/10)

Demo deployment (committed in `contracts/deployments/11155111.json`):
proxy `0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5`, ImplA `0xcEa0520134a8C0fCAdc139Bcd9fAf5D3F712910F`,
ImplB `0x1F31ab6fE4C931Ab7413523f75D490E1e0b63B4B`, ProxyAdmin `0x26c64D91f0d2e8AE6449Adf774f5Abe610e80d13`.
Watcher poll 15 s, PublicNode Sepolia RPC.

| Step | Result |
| --- | --- |
| A→B with watcher running | detected `by: "event"`, block 12072314, tx `0x226acb3b…` |
| Hard kill at cursor block 12072318, then B→A while down | — |
| Restart | `resumeFrom: 12072318`; B→A found by event (block 12072322, tx `0x26b5b849…`) |
| Final state | impl = ImplA (matches `cast storage`), `matches_baseline = true`, **`ever_changed_since_baseline = true`**, latest_change B→A with tx |
| Phase 2 (events off), A→B | detected `by: "slot"` at block 12072350 |

**A2 closed:** address-filtered `eth_getLogs` works on PublicNode Sepolia.

**Problems found and fixed on the way (each one committed):**
1. **Deploys ran out of gas.** Current Sepolia (blocks carry `blockAccessListHash`) charges far more
   for contract creation than Foundry 1.5.1's local EVM simulates: the node estimates **966,638 gas**
   to deploy DemoImplA, against ~158k simulated. Every limit derived from simulation failed with
   `gasUsed == gasLimit`, even at a 3× multiplier. Fix: `--skip-simulation`, so gas comes from the
   node. Cost of the failed attempts: ~0.001 Sepolia ETH.
2. **Zero-identity baseline.** The first attempt baselined the proxy before it existed at head-2.
   `rebaseline` now refuses an identity with no implementation or no code.
3. **Hidden forge errors.** A grep pipe swallowed forge's failure. The script now keeps full forge
   output and fails loudly.
4. **Transient RPC error.** PublicNode returned `-32001 block not found` from a lagging backend during
   phase 2. `forge_run` now retries such errors, only when the nonce shows nothing was broadcast.
   Phase 2 was rerun on the same deployment (`PHASE=2`).

---

## Test 2 — Arkiv records — PASS

**How to run:** `node --env-file=.env scripts/test2.ts` (≈4 min, mostly waiting for the 2-minute
expiry), then `node --env-file=.env scripts/cleanup-test-rows.ts`.

### Run 2 — Rabdi, with access key, 2026-11-06 ~03:45 IST — PASS (9/9, 0×429)

Output: [test2-rabdi-keyed.txt](test-runs/test2-rabdi-keyed.txt). Same 9 checks as run 1, all pass, and
the 2-minute current_state was gone after ~102 s. Cleanup confirmed no test rows left.

| Operation | n | p50 | p95 |
| --- | --- | --- | --- |
| create (incl. waiting for the receipt) | 4 | 6.2 s | 6.6 s |
| executeBatch (patch + extend) | 2 | 5.9 s | 5.9 s |
| extendEntity | 1 | 6.1 s | — |
| query, keyed | 13 | 226 ms | 304 ms |
| query, keyless | 20 | 222 ms | 478 ms |

429 responses: **0**. Writes take ~3 Arkiv blocks (2 s each) from send to receipt, which is
fine for a 120 s write cadence. One batched write per cycle keeps the watcher at ~6 s of Arkiv time
per cycle regardless of contract count (20 contracts per batch).

### Run 1 — Rabdi, keyless, 2026-11-06 ~03:25 IST — 9/9 functional checks PASS

Output: [test2-rabdi.txt](test-runs/test2-rabdi.txt). Writer funded with 10 tGLM, and 2 tGLM moved to
the watcher.

| Check | Result |
| --- | --- |
| Create baseline (writer), 2× current_state + latest_change (watcher) | PASS |
| Baseline readable with `createdBy(writer)` | PASS |
| Same query with `createdBy(watcher)` returns 0 rows (creator filter works) | PASS |
| current_state rows readable with `createdBy(watcher)` | PASS |
| One `executeBatch`: patch current_state + latest_change **and** extend current_state | PASS (`$expiresAt` 265326 → 265336, block numbers) |
| latest_change replaced in place (same key, new value) | PASS |
| Baseline identical after the state updates | PASS |
| Renewal: `extendEntity(ExpirationTime.max())` moves baseline `$expiresAt` later | PASS (8149022 → 8149042) |
| 2-minute current_state disappears from queries → reader status NOT VERIFIED | PASS (gone after ~94 s of polling) |

**Finding — keyless cost budget:** the run then stalled in the 20-keyless-read phase. Probing
directly showed **HTTP 429 `ANON_COST_LIMITED`**, with header `ratelimit: limit=10000, remaining=0,
reset=217` and `retry-after: 217`. Every read in this run was keyless (no `ARKIV_ACCESS_KEY` yet),
and the expiry polling used up the anonymous budget. viem's default retries then hid the 429 as a
hang. Consequences:
- **Watcher, importer and tests need an access key.** Keyless use is fine only for occasional reads.
- **Browser:** one bulk, contract-independent read per page load, as designed (§2.5). It must not
  poll Arkiv in a loop. A 429 is shown as NOT VERIFIED with "Arkiv rate-limited", never as GREEN.
- The test now runs keyless reads with `retryCount: 0`, logs the 429 header, and always cleans up.
  Leftover rows from run 1 were deleted with `scripts/cleanup-test-rows.ts` (writer tx `0x876c3242…`,
  watcher tx `0x5819925e…`).
- Re-run with an access key: see run 2 above.

**What the script checks:** create baseline (writer) + 2× current_state + latest_change (watcher),
query back filtered by `$creator`, confirm the wrong creator gets 0 rows, update current_state +
latest_change in **one `executeBatch`** (patch + extend), baseline byte-for-byte unchanged, renewal
via `extendEntity(ExpirationTime.max())`, a 2-minute current_state disappears → reader shows NOT
VERIFIED, 20 keyless reads, p50/p95 per operation, 429 count.

**Already established without funds (2026-11-06):**
- Keyless reads from Rabdi work: 10 queries, **p50 199 ms, max 360 ms**, no 429.
- From the SDK 1.0.1 type definitions (typechecked against the real package):
  - Batch writes are `executeBatch({ creates, patches, deletes, extensions, ownershipChanges })`,
    one transaction. **A5 closed (API side).**
  - **A patch never changes expiry** ("Use `extendEntity` for the expiry"), so a current_state
    rewrite = patch + extension in one batch.
  - `.createdBy(address)` filters on `$creator`. `ExpirationTime.max()` = longest allowed life.
  - The SDK documents `key` as "a reference to another entity", so hashes are stored as `str`
    (66 bytes, under the 128-byte limit).
  - All `dg_*` attribute names pass the SDK's runtime name grammar (`defineSchema` validates on load).

---

## E2E — watcher with the Arkiv sink on the Sepolia demo proxy — PASS

**How to run:** `bash scripts/e2e-arkiv.sh`. Everything is read back through `scripts/show-arkiv.ts`, which
trusts only the writer/watcher creators, exactly as a client would.

Run 2026-11-06 ~03:45–04:00 IST, watcher poll 15 s / write 60 s:

| Step | Read back from Arkiv |
| --- | --- |
| Baseline written by the writer (entity `0x074baf80…`, block 12072369) | impl = ImplA |
| Watcher's first cycle | current_state `matches_baseline: true`, expires in ~570 s |
| Upgrade A→B (tx `0xb5228d10…`, block 12072376) | `matches_baseline: false`, `ever_changed: true`; latest_change A→B `by: event` with tx |
| Upgrade B→A (tx `0xbd555949…`, block 12072383) | `matches_baseline: true`, **`ever_changed: true`**; latest_change B→A |
| Watcher killed, checked 11 min later | **no current_state → NOT VERIFIED**; baseline and latest_change still present |

Each change showed up on Arkiv within one watcher cycle plus one Arkiv write (~6 s) of the upgrade
passing the 2-block confirmation depth.

---

## Web app verification (build step 2) — 2026-11-06 ~04:00–04:35 IST

Checked in the in-app browser at 1366 px (plus a 768 px overflow check). Live reads were switched
to **direct mode explicitly** for these checks: Nym is left for Test 4.

| Check | Result |
| --- | --- |
| Monitored contracts loads from one bulk Arkiv read | 31 rows, ~0.4–1.1 s, 0 console errors |
| A→B→A demo proxy | GREEN with "Matches baseline now, but a change was previously detected (block 12072383)." |
| Real upgrade A→B of the demo proxy (tx `0xe9c5d01c…`, block 12072601) | live watcher logged it `by: event`; after reload the row is **CHANGE DETECTED** (red row, ImplA vs ImplB highlighted, tx link); tiles 30 / 1 / 0 |
| Check: Aave v3 `supply` 100 USDC (JSON) | intent "Supply · Amount to supply 100 USDC · Collateral recipient …"; descriptor file passes its keccak check; live read matches baseline → GREEN |
| Check: same tx as raw EIP-1559 hex | parsed from raw hex, same result |
| Check: ProxyAdmin `upgradeAndCall` on the demo proxy | flag "Code change: upgradeAndCall"; NOT VERIFIED (not monitored); raw-calldata fallback |
| Unit tests | core status 14/14, risky calldata 6/6, identity/slots 3/3, watcher engine 8/8 |

**Bug caught by the integrity check:** the first real descriptor fetch failed with "hash mismatch for
registry/aave/calldata-lpv3.json". The manifest had been built from a Windows checkout with
`core.autocrlf=true` (CRLF bytes), while GitHub serves LF. The check refused the file instead of
rendering it. The cache was re-checked out with `autocrlf=false`, and the build script now refuses
any file containing CR.

**Freshness edge found while testing:** with a 120 s watcher write interval, a 60 s poll and a 120 s
page refresh, a healthy contract could display a 300 s old record right at the 5-minute staleness
line. Check now reads Arkiv fresh on every click, and the table refreshes every 90 s.

**Non-atomic write found while testing:** right after switching the demo proxy back B→A, a reload showed
the new latest_change (B→A) next to the old current_state (mismatch), so RED stayed up for ~6 s. The
watcher wrote the two rows in separate transactions. They now go in one `executeBatch` per contract
(`Sink.writeCycle`). Regression: local Test 3 and 31 unit tests pass. The live watcher was restarted
on this code and resumed from its saved cursor on both chains.

**Not yet verified:** anything through Nym (Test 4), and Swarm-backed descriptors (Test 1).


---

## Registry mirror on Arkiv (build step 3) — 2026-11-06 ~05:00–05:35 IST — PASS

**How to run:** `npm run import -w importer -- ../.cache/registry` then
`npm run verify -w importer -- ../.cache/registry`. Logs: [import](test-runs/import-rabdi.txt) ·
[verify](test-runs/mirror-verify.txt).

| Check | Result |
| --- | --- |
| Our JCS (canonicalize 5.1.0 + keccak256) vs library `computeDescriptorHash`, every descriptor | **746/746 equal** (import aborts on any mismatch) |
| Our ERC-8176 hash vs the hash auditors signed in `sigs/` | **164/167 equal**; 3 attestations sign different content → `attestation = "stale"` (safe SafeMigration-1.5.0, safe Safe-Multisig, walletconnect wct) |
| Import run 1 | 3,443 creates (768 `dg_descriptor` + 2,675 `dg_deployment`), 173 batches, 0 failures, 17.3 min, 1.65 tGLM |
| Import run 2 (same commit) | 0 creates, 6 patches (the `ercs/` entity_dir fix below), 3,437 unchanged |
| Import run 3 (dry) | 0 creates, 0 patches |
| Client read: counts | 617 calldata / 129 EIP-712 / 22 include + 2,675 deployments = registry |
| 10 random descriptors vs GitHub raw @ `ef582c2` | **10/10**: file_sha ✓ and recomputed ERC-8176 hash ✓ |
| Browser, keyless bulk mirror read | 3,443 rows, 35 queries, ~11–13 s, no 429 |
| Browser, Check (Aave supply) via the mirror | file hash from Arkiv ✓, "bulk" provenance, intent rendered, GREEN |
| Browser, Browse "mainnet + beacon" | 28 rows / 3 queries (= 28 beacons from classification) |
| Browser, Browse "safe + eip712" | 354 rows / 5 queries (= registry: 7 descriptors, 354 deployments); stale attestation shown |

**Problems found and fixed on the way:**
1. **HTTP 413 Payload Too Large** on `eth_estimateGas` for a 50-row descriptor batch. The SDK surfaced it
   as "Execution error without revert data". Batches are now 20 ops and halve automatically on a 413.
2. **The access key leaked into an error log.** The SDK puts the key in the RPC URL path, and viem errors
   print the URL. The log was deleted before any commit (key verified absent from the tree and history),
   and all logged errors now go through `describeError()`, which redacts `ark_live_*`. The watcher was
   restarted with the redaction in place.
3. **Wrong `entity_dir` for top-level `ercs/` files** (the file name instead of `ercs`). It was fixed in the
   reader and repaired on Arkiv by the idempotent re-run (6 patches).
4. **Browse truncated at 100 rows** for OR-of-hashes queries. These now page through results (cap 500).

**Funds:** the writer has 6.33 tGLM after the import. Watcher burn is ~0.048 tGLM/h (31 contracts, 120 s
writes), so its 1.92 tGLM last ~40 h. Enough for the deadline, but a top-up is advised.
