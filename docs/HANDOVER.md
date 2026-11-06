# Argos — session handover (living status file)

**Read this first in any new session, then keep it current.** After every finished step, update
the *Current state* and *Next steps* sections below and commit. Judges read `UPDATES.md` (the
build log); this file is for whoever is driving the build next.

Last updated: **Nov 6 2026, 11:50 IST** (ETHGlobal Mumbai).

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

### P9 (1) guard demo: DONE and documented (README section, TEST_REPORT, UPDATES, AI_USAGE)

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
- Web: Check has a new example **"Guard demo proxy: increment()"** and a **"Check-and-call guard ·
  controlled demo"** panel that simulates `checkAndCall` by `eth_call` (nothing sent). The Monitored
  table labels the row "Argos guard demo proxy". **Both paths verified in the browser.**
- Counts updated to **32 monitored** in README, PITCH, SUBMISSION, VIDEO_SCRIPT.
- `scripts/demo-upgrade.sh` now uses `cast send` with retries (forge hit `block not found`) and waits for 2
  confirmations, so a rebaseline right after it records the new implementation.

### P9 (2) Nym retest: DONE — Test 4 now PASSES (11:37–11:43 IST)

The machine was re-cloned before this session, so the first job was `npm install`,
`git submodule update --init --recursive`, and restarting the watcher.

- **60/60 reads over three runs**, HTTP 200×60, p95 2.42 / 2.51 / 3.60 s (bar: ≥18/20, p95 < 10 s).
  4 of 5 cold boots ready (14.3, 12.7, 9.9, 9.9 s); the one failure was `Failed to fetch` on the
  18 MB bundle download, not the mixnet. Code identical to the 08:00 FAIL run.
- Verified **end to end in the app**: Check → Aave supply in Nym mode gave `VERIFIED · NO CHANGE`,
  live read at block 26353926 in 12.3 s via the mixnet, and the Swarm descriptor fetch *also* went
  through Nym and still passed its ERC-8176 hash check.
- **Default deliberately unchanged** (direct RPC, labelled): 10–14 s boot + ~15 s first read + 1-in-5
  boot failures would mean some visitors land on Not verified. EF target stays **Best CROPS App**.
- Cause of the original failure / the recovery: **not established**, and not claimed to be fixed.
- Raw: `docs/test-runs/test4-nym-pass.txt`. Docs updated: TEST_REPORT (row + retest section above the
  preserved FAIL section), `arkiv/friction.md` §6, README ×4, SUBMISSION ×2, PITCH Q13.

### Live state right now

- Video demo proxy `0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5`: **ImplA** (`version() = "A"`,
  checked on-chain 11:35 IST). Its Arkiv row has `ever_changed_since_baseline = true` from
  rehearsals; the video script rebaselines it before recording.
- Guard demo proxy `0x3c93e603bbeD9Dc2Af817BC2D98Bc1D35CF1D669`: **ImplA** (`version() = "A"`),
  clean baseline at block 12074155.
- Arkiv: **32 baselines, 32/32 fresh** (re-verified 11:46 IST).
- Live watcher (Arkiv sink) restarted at 11:35 IST, detached via `setsid nohup`, logging to
  `watcher/state/live.log`. Cycles are clean (`"failed":0`). It replayed Sepolia history from an
  empty cursor on first start, which is expected on a fresh clone. **No leftover test watcher
  exists any more** — that item from the previous session is moot.
- Dev server: `npm run dev -w web` on http://localhost:5180 (started this session via the
  preview tool, config in `.claude/launch.json`).
- Deployer Sepolia balance: ~0.012 ETH. Writer tGLM: enough (patches cost ~0.0005 each).
- `contracts/foundry.lock` is now gitignored: `forge` regenerates it from the submodule revisions
  that `.gitmodules` already pins.

---

## Next steps (in order)

1. ~~Finish the guard UI check~~ done.
2. ~~Document P9 (1)~~ done.
3. ~~P9 (2): one more Nym attempt~~ done — it **passed**; see the section above.
4. **Freeze pass (by 22:00):** in progress. All five checks already green on this fresh clone at
   11:40 IST — `npm run typecheck`, `npm test` (38/38), `npm run build`,
   `(cd contracts && forge test)` (11/11), `(cd web && npx tsc --noEmit -p .)`. Remaining: all 32
   fresh on Arkiv immediately before handing over, a final README read-through, push, and tell the
   owner **"ready to record"**.

## Waiting on the owner

- **Nym now works — does that change anything you want?** The EF target is currently **Best CROPS
  App** and live reads are direct-by-default. The retest numbers (60/60 reads, but a 10–14 s boot
  and 1-in-5 boot failures) support keeping both as they are, which is what the docs now say.
  Options if you disagree: (a) keep as is — recommended, lowest risk at T-10h and the CROPS work is
  what we actually built; (b) keep direct default but add a Nym beat to the video, ~20 s of extra
  runtime, no code change; (c) switch the default to Nym — needs a code change inside the freeze and
  risks a Not-verified first impression. I have written everything up as (a).

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
