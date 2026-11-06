# Argos — session handover (living status file)

**Read this first in any new session, then keep it current.** After every finished step, update
the *Current state* and *Next steps* sections below and commit. Judges read `UPDATES.md` (the
build log); this file is for whoever is driving the build next.

Last updated: **Nov 6 2026, 09:42 IST** (ETHGlobal Mumbai).

---

## Deadlines (IST)

- **Feature freeze: Fri Nov 6, 22:00.** After that: docs, video and bug fixes only.
- First full submission (with video): target Fri Nov 6, 23:30.
- **Hard deadline: Sat Nov 7, 09:00.** Late submissions are not accepted.

## Standing rules (from the owner's brief; they still apply)

- Work autonomously through the next steps. Stop and ask only for things only the owner can do:
  funds or faucets, keys, recording the video, clicking submit, or a real blocker. When you ask, give
  2–3 options with a recommendation, and keep working on anything not blocked.
- **Honest claims only.** Argos detects, verifies and warns. Never write "safe", "malicious",
  "prevents hacks" or "atomic protection". A status is "as of block N".
- **Secrets only in `.env` (gitignored).** Never print, `cat` or commit it, and never ask the owner to
  paste keys in chat. Check a variable with its length, not its value.
- **Never rename live-data identifiers:** Arkiv schemas `dg_*`, entity attributes, env names, cursor
  files, the `@driftguard/*` package scope. User-facing name is **Argos**.
- Don't invent APIs, versions or endpoints: read the installed package source or official docs.
- Commit small and often, push after each step (judges read the history). End commit messages with
  the attribution line the session's system reminder gives.
- Keep `UPDATES.md`, `docs/TEST_REPORT.md` and `AI_USAGE.md` current. **Use real times:** run `date`
  or read `git log --date=format:%H:%M`. Never guess the clock.
- **Keep the watcher running.** Before the video and before judging, all monitored contracts must
  be fresh on Arkiv: `node scripts/show-arkiv.ts | grep -c '"matches_baseline": true'`.
- Prize targets: **Arkiv** "Mirror something Ethereum depends on" (confirmed eligible by the Arkiv
  booth on Nov 6) + Arkiv + Swarm bonus; **EF** "Best CROPS App", lead property **Security**. No third
  pick. Rules: https://ethglobal.com/events/mumbai/prizes (Arkiv and EF sections).

## What Argos is (one paragraph)

Contract-change detection for ERC-7730 clear-signing descriptors. Descriptors are bound to proxy
addresses, so after an upgrade a wallet keeps showing a confident intent while different code runs.
314 of 652 mainnet registry contracts (48%) are proxies. Argos mirrors the EF ERC-7730 registry to
Arkiv (768 `dg_descriptor` + 2,675 `dg_deployment`), keeps descriptor content on Swarm (746 refs in
`dg_descriptor.swarm_ref`), records baselines, runs a watcher that publishes `dg_current_state`
(10-minute expiry) and `dg_latest_change`, and a static web app shows raw hex → readable intent →
Verified / Change detected / Not verified. Architecture: `docs/ARCHITECTURE.md`.

---

## Current state

### Done and pushed (through commit `5f58df6`)

| Priority | Result | Where |
| --- | --- | --- |
| P0 rename | User-facing DriftGuard → Argos; `dg_*` and `@driftguard/*` kept on purpose | README note at top |
| P1 Arkiv mirror | Live and verified (counts + 10/10 spot-checks, twice); pin `ef582c2` = upstream master | `arkiv/data-quality.md`, `scripts/query-mirror.ts` |
| P2 Swarm | 746 descriptors on Swarm via the **public gateway** (gateway's own stamp), each read back and keccak-checked; refs patched onto Arkiv; web reads Swarm first, rejects tampering, falls back to registry on network failure | `importer/src/swarm.ts`, `web/src/lib/descriptors.ts`, `arkiv/swarm.md`, TEST_REPORT Test 1 |
| P3 Arkiv docs | friction, reach (adoption numbers), why-arkiv, data-quality, schema all answer the rubric | `arkiv/*.md` |
| P4 CROPS | README "CROPS" section in EF format, third-party privacy table, keyless quick start (verified from a fresh clone) | `README.md` |
| P5 UI polish | Eye logo, "How it works" tab with diagram, Arkiv/Swarm links on every screen; checked at 1366 px | `web/src/screens/HowItWorks.tsx` |
| P6 video script | Two clips, rehearsed timings (upgrade tx 14 s, watcher writes RED ~70 s later) | `docs/VIDEO_SCRIPT.md`, `scripts/demo-upgrade.sh` |
| P7 submission text | All form fields + per-partner feedback | `docs/SUBMISSION.md` |
| P8 pitch | 4-min live demo + 20 hard questions | `docs/PITCH.md` |

### P9 (1) guard demo: in progress (committed with this file, not yet documented)

Owner chose: **guard on a new, separate Sepolia proxy** (the video's demo proxy is untouched).

- Contracts (forge tests **11/11 pass**, 7 new):
  - `contracts/src/ArgosGuardableProxy.sol`: OZ TransparentUpgradeableProxy whose own fixed code
    answers `argosImplementation()` from the EIP-1967 slot. Upgrades can't change that code.
  - `contracts/src/ArgosGuard.sol`: `checkAndCall(proxy, expectedImplementation, data)` reverts with
    `ImplementationChanged(proxy, expected, actual)` unless the implementation matches, else forwards the
    call. Limit: the target sees the guard as `msg.sender`.
  - `contracts/script/DeployGuardDemo.s.sol`; `UpgradeDemo.s.sol` now takes `DEPLOYMENT=<file>`.
- **Deployed on Sepolia** (`contracts/deployments/11155111-guard.json`): guardable proxy
  `0x3c93e603bbeD9Dc2Af817BC2D98Bc1D35CF1D669`, guard `0x32189Bb40fD8E565a870d6b513F1E32e6832E46a`,
  proxyAdmin `0x7e887afF80839fb17F139D9a0A02E572BE8f912A`; reuses DemoImplA/B. Log:
  `docs/test-runs/guard-deploy-sepolia.txt`.
- **Argos baseline written** for the guard proxy (writer key, ImplA). So Arkiv now holds **32
  baselines** (30 mainnet + 2 Sepolia proxies). Docs still say 31 in many places.
- `scripts/guard-demo.ts` **ran end to end** (`docs/test-runs/guard-demo-sepolia.txt`): expected impl
  read from the Argos baseline on Arkiv → guarded `increment()` mined (counter 0→1) → upgrade to B →
  same guarded call **reverted** with `ImplementationChanged(ImplA, ImplB)`, counter stayed 1 → restored A.
- `scripts/demo-upgrade.sh A|B [guard]` works for either proxy. Note: its final slot read can hit a
  lagging RPC backend and show the old value; confirm with
  `cast call <proxy> "version()(string)" --rpc-url $SEPOLIA_RPC_URL`.
- Web: Check has a new example **"Guard demo proxy: increment()"** and a **"Check-and-call guard ·
  controlled demo"** panel that simulates `checkAndCall` by `eth_call` (nothing sent). The Monitored
  table labels the row "Argos guard demo proxy". Verified in the browser: **success path** renders
  "would succeed: implementation matches the baseline". **Revert path not yet checked in the UI.**

### Live state right now

- Video demo proxy `0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5`: **ImplA** (version "A").
  Its Arkiv row has `ever_changed_since_baseline = true` from rehearsals; the video script rebaselines it before recording.
- **Guard demo proxy: ImplB (version "B"), deliberately**, for the UI revert test. Restore it.
- Live watcher (Arkiv sink) runs in the background as `node --env-file=.env watcher/src/main.ts`,
  logging to `watcher/state/live.log`. A leftover test watcher (`node watcher/src/main.ts`, started
  by `scripts/test3.sh`, file sink only, harmless) is also running; the owner should stop it.
- Dev server: `npm run dev` on http://localhost:5180 (already running in the owner's terminal).
- Deployer Sepolia balance: ~0.012 ETH. Writer tGLM: enough (patches cost ~0.0005 each).

---

## Next steps (in order)

1. **Finish the guard UI check:** in the app, Check → *Guard demo proxy: increment()* → the panel must
   say "would revert: ImplementationChanged…". Then `bash scripts/demo-upgrade.sh A guard`, confirm
   version "A", and rebaseline the guard proxy so its row is plain green:
   `npm run rebaseline -w watcher -- --chain 11155111 --address 0x3c93e603bbeD9Dc2Af817BC2D98Bc1D35CF1D669 --kind eip1967 --reason "clean state after guard demo"`.
2. **Document P9 (1)**, always as a *controlled demo* (never "atomic protection"):
   - README: short section "Check-and-call guard (controlled demo)" with addresses, the limits
     (only proxies with this getter; target sees the guard as sender; no registry contract has it), and
     `node --env-file=.env scripts/guard-demo.ts`. Add it to the Setup command table.
   - `docs/TEST_REPORT.md`: a "Guard demo" entry (forge 11/11, Sepolia deploy, demo run log, UI check).
   - `UPDATES.md` entry with real times; `AI_USAGE.md` rows for the new contracts, script and panel.
   - **Counts: 31 → 32 monitored** (30 mainnet + 2 Sepolia). `grep -rn "31" README.md docs arkiv web/src`
     and fix only the monitored-contract counts (e.g. VIDEO_SCRIPT's `grep -c … → 31`, PITCH, SUBMISSION,
     README "31 baselines").
   - `docs/PITCH.md` Q3 (TOCTOU): mention the controlled guard demo as how the gap closes when a proxy
     exposes a trustworthy getter.
3. **P9 (2): one more Nym attempt, strict 30-minute timebox.** Record the result in TEST_REPORT
   (Test 4) and friction.md either way. Don't change the direct-by-default behaviour unless Nym works
   reliably (≥18/20 reads, p95 < 10 s on the Nym diagnostics screen).
4. **Freeze pass (by 22:00):** `npm run typecheck`, `npm test`, `npm run build`,
   `(cd contracts && forge test)`, `(cd web && npx tsc --noEmit -p .)`; all 32 fresh on Arkiv; final
   README read-through; push; tell the owner **"ready to record"**.

## Waiting on the owner

- **Swarm booth batch (optional, improves the bonus):** if `BEE_API_URL` and `SWARM_POSTAGE_BATCH_ID`
  appear in `.env`, run `npm run swarm -w importer -- ../.cache/registry --restamp`. It re-uploads under
  our batch and asserts every ref is unchanged (no Arkiv writes). Then fill the batch ID and buyer into
  `arkiv/swarm.md` and update PITCH Q11 and SUBMISSION.
- **Onay:** no public description was found; PITCH Q2 avoids describing it. The owner should confirm
  what it is before judging.
- Stop the leftover test watcher (see *Live state*).
- Record the video (`docs/VIDEO_SCRIPT.md`), then fill the timestamps into `arkiv/swarm.md` and
  `docs/SUBMISSION.md`, and click submit.

## Useful commands

```bash
node scripts/show-arkiv.ts                       # every monitored contract's status from Arkiv (no keys)
node scripts/query-mirror.ts stale               # registry mirror query (no keys)
npm run verify -w importer -- ../.cache/registry # mirror verification (no keys)
bash scripts/demo-upgrade.sh A|B [guard]         # move a Sepolia demo proxy
node --env-file=.env scripts/guard-demo.ts       # full guard demo on Sepolia
tail -5 watcher/state/live.log                   # is the watcher cycling? ("failed":0)
```
