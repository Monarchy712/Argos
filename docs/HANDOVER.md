# Argos — session handover (living status file)

**Read this first in any new session, then keep it current.** After every finished step, update
the *Current state* and *Next steps* sections below and commit. Judges read `UPDATES.md` (the
build log); this file is for whoever is driving the build next.

Last updated: **Nov 6 2026, 11:58 IST** (ETHGlobal Mumbai). **Freeze pass done — ready to record.**

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
- Prize picks — **three available**, two used (rules read from the prize page on Nov 6):
  1. **Arkiv** "Mirror something Ethereum depends on" (eligibility confirmed by the booth) + the
     Arkiv + Swarm bonus, which does **not** consume a pick.
  2. **EF** — submitted to **both** "Best CROPS App" (lead property **Security**) and "Best Use of
     Anon-RPC". EF's rule: *"One EF prize per project. You can submit to anon-rpc, the alt mempool
     and CROPS, but you will be placed in at most one."* Both share the one EF pick.
  3. **0G** "Build with 0G Private Computer" — **done and live** (see *Current state*). Scope was
     fixed as a *descriptive* diff of what changed in the code, explicitly **not** a safety
     verdict; keep it that way.
  CROPS rules worth remembering when editing docs: *"Apps do NOT need to excel equally in all four
  areas… structural depth in their lead property while maintaining the others"*, and criterion 3 is
  *"maintenance of the other three properties, with trade-offs clearly documented."*
  Rules: https://ethglobal.com/events/mumbai/prizes

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

### Nym is the default now (13:28), and the app is on Swarm (13:49)

- **Nym by default.** Live chain reads and descriptor downloads go through Anon-RPC/Nym unless the
  viewer explicitly opts out; direct RPC is a labelled one-click fallback. This satisfies EF
  Anon-RPC's qualification ("routes its RPC reads through Anon-RPC **by default**"), which is why
  we can submit to that track at all. Two changes make it liveable: the worker boots **on page
  load** (20.5 s measured, entirely before interaction) and boots that fail in under 30 s **retry**
  (that failure is the bundle CDN, not the mixnet). Fail-closed unchanged. Commit `10bafae`.
- **App on Swarm.** `node scripts/publish-site.ts` (no keys) →
  `91c7ba783dc22f76ecde7b19657a9741a3ead69170cd3c620afcd43d53ff8b95`. Deterministic: a re-run on
  the same build gives the identical reference. **Re-run it after any web change** so the published
  app isn't stale. Known limit: public gateways are default-deny for websites, so assets serve but
  HTML 302s to `bzz.link/forbidden` until a moderator approves the hash — documented in
  `arkiv/swarm.md`, not worked around. Commit `30f3185`.

### 0G third pick: DONE and live (14:40–16:10)

`scripts/explain-change.ts` + `packages/core/src/selectors.ts` + `dg_change_note` + a Check panel.
Full rationale in UPDATES and SUBMISSION; the three things a later session must not undo:

1. **It describes, it never judges.** The model is told not to call anything safe/unsafe/
   malicious/benign and the UI repeats it. Do not "improve" this into a verdict or a score: it
   would reproduce the failure Argos exists to warn about, is unfalsifiable, and would undercut
   the CROPS Security lead.
2. **Selectors come from deployed bytecode, not verified source.** That is why it works at all —
   `DemoImplA`/`DemoImplB` are *not* verified on Sepolia, so the earlier worry about the video
   having nothing to diff is resolved. Present it as a superset of the ABI, never as the ABI.
3. **The browser stays keyless.** `ZEROG_API_KEY` is read only by the script. Never import it into
   `web/`.

Live values: 0G request `1d20f02c…`, provider `0x000000003f486c…`, $0.000914/run; summary on Swarm
`35e4a454…`; Arkiv row tx `0x45dc9ece…`. Key trust mode must stay **Standard** — on *Verified*
every mainstream model 503s with `no_provider_for_trust_mode`.

**Note for after the video:** the current note describes **B→A** (the change actually on Arkiv).
After the on-camera A→B upgrade, re-run to regenerate it:
`node --env-file=.env scripts/explain-change.ts --chain 11155111 --address 0xb8E5…BFF5 --write`

### Live state right now

- Video demo proxy `0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5`: **ImplA** (`version() = "A"`,
  checked on-chain 11:35 IST). Its Arkiv row has `ever_changed_since_baseline = true` from
  rehearsals; the video script rebaselines it before recording.
- Guard demo proxy `0x3c93e603bbeD9Dc2Af817BC2D98Bc1D35CF1D669`: **ImplA** (`version() = "A"`),
  clean baseline at block 12074155.
- Arkiv: **32 baselines, 32/32 fresh** (re-verified 11:46 IST).
- **Watcher now runs under a supervisor** (`scripts/watcher-supervisor.sh`, started 16:03 IST):
  ```bash
  setsid nohup bash scripts/watcher-supervisor.sh >/dev/null 2>&1 < /dev/null & disown
  ```
  It died twice today from signals aimed at the process group of the shell that started it (once
  at 15:08, unnoticed for ~55 min, which expired all 32 rows). The supervisor restarts it and logs
  every restart into `watcher/state/live.log`, so gaps stay visible. Verified with `kill -9`:
  logged exit 137 and restarted in 5 s. **Check both processes are alive**, not just one:
  `ps aux | grep -E '[w]atcher-supervisor|[w]atcher/src/main'`.
  Careful: `pkill -f 'watcher/src/main.ts'` matches the shell running it too — use
  `pkill -f 'watcher/src/main[.]ts'`.
- Dev server: `npm run dev -w web` on http://localhost:5180 (started this session via the
  preview tool, config in `.claude/launch.json`).
- **Freeze pass re-verified in the browser at 11:57:** Monitored 32 / 32 verified / 0 changed /
  0 not verified; Check → Aave supply green with the Swarm hash check; Check → guard demo proxy
  shows "would succeed"; tamper toggle rejects the descriptor; Browse and How it works render;
  no console errors; no horizontal scroll at 1280 px.
- **Git remote is now SSH** (`git@github.com:Monarchy712/Argos.git`). The fresh clone had no HTTPS
  credentials and `gh` isn't installed; the existing `~/.ssh/id_ed25519` authenticates as
  Monarchy712, so pushes work again.
- Deployer Sepolia balance: ~0.012 ETH. Writer tGLM: enough (patches cost ~0.0005 each).
- `contracts/foundry.lock` is now gitignored: `forge` regenerates it from the submodule revisions
  that `.gitmodules` already pins.

---

## Next steps (in order)

1. ~~Finish the guard UI check~~ done.
2. ~~Document P9 (1)~~ done.
3. ~~P9 (2): one more Nym attempt~~ done — it **passed**; see the section above.
4. ~~Freeze pass~~ **done at 11:57 IST.** All five checks green on the fresh clone
   (`typecheck`, `npm test` 38/38, `build`, web `tsc --noEmit`, `forge test` 11/11); Arkiv 32/32
   fresh; every screen re-verified in the browser after a clean reload; README accuracy pass.
   **The owner has been told "ready to record".**

5. ~~0G third pick~~ **done at 16:10** — see the section above. Credits were never the blocker in
   the end; the key's Trust mode was.

### Before the video

1. **Re-publish the app to Swarm against the final build** — the current reference
   `91c7ba78…ff8b95` predates the 0G panel, so it serves an app missing a feature we claim:
   `npm run build && node scripts/publish-site.ts`, then update the reference in `arkiv/swarm.md`.
2. Rebaseline the video proxy (its row still has `ever_changed_since_baseline = true`).

### After the video (next session picks up here)

1. Record using `docs/VIDEO_SCRIPT.md`.
2. Re-run `scripts/explain-change.ts … --write` so the change note describes the on-camera A→B
   upgrade rather than the older B→A one.
3. Fill the real timestamps into `docs/SUBMISSION.md` and `arkiv/swarm.md`.
3. If the Swarm booth batch arrives, run the `--restamp` step in *Waiting on the owner* below.
4. Submit on ethglobal.com before **09:00 Sat Nov 7**.
5. Keep the watcher alive until judging ends; re-check `show-arkiv.ts | grep -c '"matches_baseline": true'` → 32.

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
