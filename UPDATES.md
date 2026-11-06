# Build log (for judges)

A dated, append-only log of what was built, what was verified, and what changed along the
way. Times are IST. Each entry points at the commits it covers.

## 2026-11-05 — Day 1

### ~21:50 · Repo scaffold
- Created the repo with `.gitignore` (secrets ignored before the first commit), MIT `LICENSE`,
  `.env.example` (placeholders only), and stubs for `README.md`, `AI_USAGE.md` and the
  `arkiv/` prize docs.
- Commit: `chore: scaffold repo with gitignore, MIT license and submission stubs`

### ~22:40 · Architecture blueprint (awaiting review)
- Wrote `docs/ARCHITECTURE.md`. Every external claim is marked VERIFIED (with source) or ASSUMED.
- Checked against the installed packages and official sources:
  - Arkiv SDK 1.0.1: Rabdi (chain 7794095) RPC/explorer, 32-attribute and 128 KiB caps,
    100-row pages, max lifetime of 7,884,000 blocks (about 182.5 days).
  - Anon-RPC harness is now **0.4.0** (the spike used 0.3.2). The Nym specifier is confirmed
    in the upstream `adopters.json5`.
  - ERC-8176 descriptor hash = keccak256 of the JCS form of the *resolved* descriptor.
    `@ethereum-sourcify/clear-signing` exports `computeDescriptorHash`.
  - Swarm uploads need a paid postage batch (bee-js 13.2.0).
- Design change from these findings: Swarm stores the JCS bytes of the resolved descriptor,
  so one hash proves both Swarm integrity and the ERC-8176 identity.
- Added the `arkiv/swarm.md` stub that the Arkiv + Swarm bonus requires.
- Problem hit: the GitHub REST API is rate-limited on the venue IP, so we read files
  through raw.githubusercontent.com instead.

## 2026-11-06 — Day 2

### Blueprint approved (v1)
- Approved with decisions D1–D3, plus a lower Arkiv write rate: slot reads every 60 s,
  `current_state` written every 120 s or immediately on change, batched where possible. Mainnet
  monitoring is capped at ~30 registry proxies (attested ones first), plus the Sepolia demo proxy.
- Generated the writer, watcher and Sepolia-deployer wallets locally. Keys are only in the
  gitignored `.env`, and the public addresses are in `docs/ARCHITECTURE.md` §11.
- Found that the PublicNode RPC rejects `eth_getLogs` without an address filter. The watcher
  always passes one.

### Test 3 (proxy detection): local PASS, Sepolia waiting on funds
- Demo contracts: `DemoImplA`/`DemoImplB` behind an OpenZeppelin v5.6.1
  `TransparentUpgradeableProxy`, with deploy/upgrade scripts (Foundry, pinned submodules).
- `packages/core`: EIP-1967 slots, the code-identity model, and an on-chain reader for
  EIP-1967, beacon, diamond, Safe and plain contracts.
- Watcher: a pure detection engine (sticky `ever_changed`), address-filtered event scans, an
  atomic cursor file, a file sink and the rebaseline CLI.
- `scripts/test3.sh local` passes all 10 checks. That includes a hard kill with an upgrade made
  while the watcher was down, plus slot-only detection with event scanning switched off. See
  `docs/TEST_REPORT.md`.
- Blocked: the Sepolia deployer and both Arkiv wallets need testnet funds. Faucets are a user
  action.

### Test 2 (Arkiv): script ready, blocked on faucet
- Added `dg_*` Arkiv schemas in `packages/core/src/arkivSchemas.ts` and the Test 2 script
  (`scripts/test2.ts`). The script typechecks against the real SDK 1.0.1.
- Learned from the SDK types: a patch never moves expiry, so a `current_state` rewrite is a
  patch plus an `extendEntity` in a single `executeBatch`.
- Keyless Rabdi reads measured at p50 199 ms.
- Waiting on tGLM for the writer and watcher wallets.

### Test 2 passed; Sepolia gas surprise; Arkiv sink built
- **Test 2 (Arkiv): 9/9 functional checks pass** on Rabdi:
  - The `$creator` filter rejects the wrong wallet.
  - A single `executeBatch` patches and extends `current_state`.
  - The baseline stays untouched after state updates, and renewal works.
  - A 2-minute `current_state` lapses into NOT VERIFIED.
- Found that keyless Arkiv reads have a cost budget (`429 ANON_COST_LIMITED`, limit 10000, reset
  ~217 s). Because of this, the watcher and importer use an access key, and the browser keeps to a
  single bulk read.
- Sepolia deploys ran out of gas. The node estimates ~6x more creation gas than Foundry 1.5.1's
  local EVM simulates (current Sepolia blocks carry `blockAccessListHash`). Test 3 now uses
  `--skip-simulation`, so gas comes from the node.
- `rebaseline` now refuses an all-zero identity. That bug once baselined a proxy that wasn't
  deployed yet.
- Built the Arkiv sink (one batch per cycle; create+delete on rebaseline; retry when an expired
  row is found), the `renew` script, and a cleanup script for test rows.

### Watcher → Arkiv works end to end; mainnet monitoring set chosen
- **Test 3 passes on Sepolia (10/10).** Problems along the way: Sepolia charges ~6x more gas to
  create contracts than Foundry's local EVM simulates, and a PublicNode backend lagged
  (`block not found`). Both are now handled in the test script.
- **Test 2 passes with the access key (9/9, 0×429).** Reads take ~226 ms; writes take ~6 s to
  receipt.
- **E2E passes.** The watcher with the Arkiv sink tracked A→B→A on the Sepolia demo proxy, and
  every step was read back from Arkiv. After the watcher was killed, its `current_state` expired
  and the contract showed NOT VERIFIED.
- Classified all 652 mainnet contracts in the ERC-7730 registry: **48% are upgradeable proxies**.
  Selected 30 across 19 protocols, attested first, for the watcher to monitor. Without a cap,
  ~20 Kiln vaults behind one shared beacon would have filled the list.
- Watcher hardening: a failed read for one contract no longer fails the cycle. That contract goes
  stale (NOT VERIFIED) and its events are replayed later.
- README now has the problem statement, wallets, setup and a runnable Arkiv query.
  `arkiv/schema.md` is filled in.

### Build step 1 done: watcher + Arkiv records live
- Wrote 30 mainnet baselines to Arkiv with `npm run seed -w watcher` (writer wallet).
- The live watcher now monitors 31 contracts (30 mainnet + the Sepolia demo proxy). It reads
  every 60 s and writes `current_state` every 120 s or on change.
- First live cycle: mainnet 30/30 read and written in 38 s with 0 failures. A client reading
  Arkiv sees 31/31 with a live `current_state`, all matching baseline. The Sepolia demo proxy
  shows "matches baseline now, but changed before" (`ever_changed_since_baseline`).
- Two problems found on the first live run and fixed: PublicNode allows at most 10 addresses per
  `eth_getLogs`, and a failure on one chain used to skip the other chain.
- Caveat: the watcher currently runs on the developer's laptop. While it's off, the contracts
  correctly show NOT VERIFIED.

### Build step 2: companion web app (three screens)
- `packages/core`: `status.ts` (GREEN / RED / NOT VERIFIED with reasons and the A→B→A note; 14
  tests, including one that no wording judges intent) and `risky.ts` (upgrade / admin /
  masterCopy / diamondCut calls and Safe `operation=1`; 6 tests).
- Web app (Vite 8.3.5 + React 19.2.9):
  - **Monitored contracts**: one bulk Arkiv read per trusted writer.
  - **Check a transaction**: JSON or raw hex input, readable ERC-7730 intent, risky-calldata flags,
    a live check and descriptor provenance.
  - **Nym diagnostics**: Test 4, "Run 20 reads".
- Live reads and descriptor fetches go through Anon-RPC/Nym by default, with no silent fallback.
  Direct mode is explicit, labelled, and never saved.
- Descriptors come from a hash-pinned registry manifest (777 files keccak-checked, 612 ERC-8176
  hashes) behind a `DescriptorSource` interface that Swarm will plug into.
- Verified in the browser in direct mode: Aave v3 `supply` renders "Supply 100 USDC" and is GREEN
  with a matching live read. A real A→B upgrade of the Sepolia demo proxy turned its row RED
  within one watcher cycle; it was then switched back.
- The descriptor integrity check caught a real bug on its first fetch (CRLF checkout on Windows),
  now fixed and guarded.
- Not yet done: Nym (Test 4, morning browser run) and Swarm (Test 1).
- Found and fixed while testing the UI: the watcher wrote `latest_change` and `current_state`
  in two transactions ~6 s apart, so readers could briefly see a mixed state. A contract's rows
  are now written atomically in one `executeBatch`. The live watcher was restarted and resumed
  from its cursor.

### Build step 3: ERC-7730 registry mirror on Arkiv
- **Importer** (`importer/`): reads the registry at pinned commit `ef582c2` and resolves includes.
  It computes the ERC-8176 hash two ways (our JCS and the library's) and aborts on any mismatch;
  there were none across 746 descriptors. It also compares our hashes with the auditors'
  attestations: 164/167 match, and 3 are flagged as **stale attestations** (a real registry
  finding). Writes are idempotent, resumable, and batched (20 ops, halving on HTTP 413).
- **Live on Rabdi:** 768 `dg_descriptor` + 2,675 `dg_deployment` rows, cost 1.65 tGLM. A re-run
  plans 0 creates. The client-side verifier confirms counts match and 10/10 random descriptors
  match GitHub raw files and recomputed hashes.
- **Web:** Check takes descriptor metadata from the Arkiv mirror (bulk read cached for the session,
  so the Arkiv node can't tell which contract; a targeted fallback is shown when used). New
  **Browse mirror** view runs Arkiv queries by chain, protocol, kind, proxy kind and monitored.
- **Docs:** real drafts of `arkiv/friction.md`, `reach.md` (registry issues #3098/#2975 re-read;
  our earlier framing of #2975 was corrected), `why-arkiv.md` and `data-quality.md`, plus a README
  CROPS section and a "what the Arkiv node can learn" table.
- Found and fixed: Arkiv access key leaking via error URLs (now redacted everywhere), 413 batch
  limit, `ercs/` protocol field, Browse truncation at 100 rows.
- Funds: writer 6.33 tGLM; watcher ~40 h of runway at the current rate (top-up advised).

### Test 4 (Nym): FAIL → EF target is now Best CROPS App
- The Nym worker never became ready within 120 s on venue Wi-Fi or on a phone hotspot, with harness
  0.4.0 or the spike-era 0.3.3. The specifier read and the 18 MB bundle download (hash-verified)
  both work, so the failure is inside the worker or the mixnet connection.
- Per the plan's rule (≥18/20, p95 < 10 s, otherwise switch), the EF target moves from "Best Use of
  Anon-RPC" to "Best CROPS App". The app still fails closed in Nym mode and never falls back
  silently.
- Fixed while debugging: a failed boot no longer retries for every read (it used to look like a
  multi-minute hang). The diagnostics screen shows boot progress and has a harness A/B switch.


### After Test 4: direct by default, CROPS with Security as the lead, tamper demo
- The 45-minute Nym timebox ended without a fix. The specifier, bundle, Nym API and gateways all
  work from the venue (TCP 9000/9001/443 open), but the nested tunnel worker hangs silently with
  harness 0.4.0, 0.3.3 and 0.3.2. Root cause notes are in `docs/TEST_REPORT.md` and
  `arkiv/friction.md`.
- The web app now defaults to **direct RPC, labelled "not anonymized"** everywhere. **Try Nym
  (experimental)** stays one click away and fails closed.
- EF target: **Best CROPS App**, with **Security** as the lead. The README CROPS section is rewritten
  Security-first, honest about privacy, and lists the four demo moments.
- New demo moment: **"tamper with the downloaded descriptor"** on the Check screen. The keccak check
  against the hash on Arkiv rejects it ("Descriptor rejected: integrity check failed", with expected
  and actual hashes), and the untampered run renders normally. Both were checked in the browser.

### Morning · Arkiv eligibility confirmed; renamed to Argos
- **Arkiv booth (Nov 6 morning): confirmed eligible** for "Mirror something Ethereum depends on"
  with the ERC-7730 registry mirror. No Build-track fallback is needed.
- Renamed the project from DriftGuard to **Argos** everywhere a user sees it (web app, README,
  docs, `arkiv/*.md`, package descriptions). Arkiv schema names (`dg_*`), entity attributes, env
  variables, cursor files and the internal `@driftguard/*` package scope keep the working name, so
  the records already on Arkiv stay valid.

### ~08:55 · Mirror re-verified; query script
- Build step 3 was already complete. Re-ran `npm run verify -w importer`: counts match the registry
  and 10/10 fresh random spot-checks match GitHub raw. Upstream `master` is still `ef582c2`, so the
  mirror is current.
- Added `scripts/query-mirror.ts` (stale attestations, descriptors for a contract, one registry
  folder), with an explorer link per entity. Linked from the README.

### ~09:15 · Swarm (Test 1): descriptors on Swarm, refs on Arkiv, browser reads Swarm first
- The Swarm booth details weren't in `.env` yet. We found that the public gateway
  (`api.gateway.ethswarm.org`) accepts stampless `POST /bytes` and stamps uploads itself, so we went ahead with it.
- `importer/src/swarm.ts` (bee-js 13.2.0): uploads the resolved JCS bytes of all **746**
  descriptors, reads each back and checks keccak256 = ERC-8176 hash, then patches the 746
  `dg_descriptor` rows on Arkiv (`swarm_ref`, `storage_mode = swarm`). 53 s of uploads, 0 failures.
- Web: `SwarmFirstSource` fetches from Swarm by the Arkiv ref and checks the hash. If Swarm is
  unreachable it falls back to the registry (labelled); a hash mismatch is rejected. All three paths were checked in the browser.
- `arkiv/swarm.md` written. Open item: put the content under the booth's own batch with `--restamp`
  (same references, no Arkiv change) once `BEE_API_URL` / `SWARM_POSTAGE_BATCH_ID` are set.

### ~09:30 · Arkiv docs pass (P3)
- `reach.md` gains the numbers the rubric asks for: 95 registry contributors, 559 commits, 222 forks,
  4,310 monthly npm downloads of `@ethereum-sourcify/clear-signing`, and 2,060 contracts on 151 chains from 85
  protocol folders.
- `why-arkiv.md` opens with direct answers to "what would people lose on Postgres" and "what can
  they do that GitHub can't". A claim about running your own watcher was made precise (it needs a fork with your own
  addresses in `trust.ts`).
- `data-quality.md`: "is it up to date" answered with a check anyone can run, plus a table of real
  search questions → the Arkiv query → a command or Browse filter.
- `friction.md`: expected / happened / reproduce for each breakage.
- `schema.md`: Swarm fields and queries. Corrected a wrong claim: importer re-runs don't renew expiry
  (a patch never moves it). Renewal is `npm run renew` only.

### ~09:45 · CROPS requirements (P4)
- README **CROPS** section rewritten in the EF format: one short line each for S (lead), C, O, P, then
  details and the three stated trade-offs (one watcher, direct Arkiv reads, direct live reads).
- A "What each third party can learn" table now covers Ethereum RPC, the Swarm gateway, GitHub raw, our
  (nonexistent) server, and analytics (none), alongside the Arkiv table.
- No trackers or analytics: grep of `web/` plus the browser's resource list (only Arkiv RPC, Ethereum RPC,
  the Swarm gateway, and GitHub raw on fallback).
- **Quick start (no keys)** added at the top of the README. Verified from a fresh clone with no `.env`:
  `npm ci`, typecheck, 38/38 tests, build, `show-arkiv` (31 contracts fresh), `query-mirror stale` (3 rows).
