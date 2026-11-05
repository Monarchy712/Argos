# Risk test report

Results of the risk tests from `docs/ARCHITECTURE.md`, newest first within each test. Raw run
output is committed under `docs/test-runs/`.

| Test | Status | Run output |
| --- | --- | --- |
| 3 — proxy detection | **Local anvil: PASS** · Sepolia: **BLOCKED** (deployer unfunded) | [test3-local.txt](test-runs/test3-local.txt) |
| 2 — Arkiv records | **BLOCKED** (writer/watcher wallets have 0 tGLM) | — |
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

## Test 2 — Arkiv records — BLOCKED (script ready)

- Writer `0x623EdFf351EB13aCCFc56cBf541eE4D45BDADCf4` and watcher
  `0x8a883182b488cE04f08D348C64d9AC8EecACF2Bf` have **0 tGLM** on Rabdi.
- Faucet: `hub.arkiv.network/faucet`. Spike S1 measured ~0.00013 tGLM per entity, so a few tGLM per wallet is plenty.
- An access key (`hub.arkiv.network/access-keys`) is optional for the test but recommended. Without one
  the SDK warns that the public endpoint is heavily rate limited.
- Once funded: `node --env-file=.env scripts/test2.ts` (≈4 min, most of it waiting for the
  2-minute expiry).

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
