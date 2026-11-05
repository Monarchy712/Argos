# Risk test report

Results of the risk tests from `docs/ARCHITECTURE.md`, newest first within each test. Raw run
output is committed under `docs/test-runs/`.

| Test | Status | Run output |
| --- | --- | --- |
| 3 — proxy detection | **Local anvil: PASS** · Sepolia: **BLOCKED** (deployer unfunded) | [test3-local.txt](test-runs/test3-local.txt) |
| 2 — Arkiv records | **PASS** (9/9 functional); keyless reads hit a 429 cost limit, keyed re-run pending | [test2-rabdi.txt](test-runs/test2-rabdi.txt) |
| 4 — Nym reads | not started (by plan: needs a real browser on venue Wi-Fi) | — |
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

### Run 2 — Sepolia — BLOCKED

- Deployer `0x060762aa5D602d1A6E9a5AecC3301cf804b7E42C` has **0 Sepolia ETH** (checked 2026-11-06).
- Needs roughly 0.01 Sepolia ETH (3 contracts plus 3 upgrades).
- RPC: PublicNode Sepolia works (chain 11155111). It rejects `eth_getLogs` without an `address`
  filter (error -32701), which the watcher always sets. **A2** (2k-block log ranges with an
  address filter) gets checked in this run.
- Once funded: `bash scripts/test3.sh sepolia` (≈5 min with 60 s waits).

---

## Test 2 — Arkiv records — functional PASS (9/9), keyless rate limit found

**How to run:** `node --env-file=.env scripts/test2.ts` (≈4 min, mostly waiting for the 2-minute
expiry), then `node --env-file=.env scripts/cleanup-test-rows.ts`.

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
- Re-run with an access key pending, for clean keyed timings (p50/p95).

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
