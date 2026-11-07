# Argos — demo video script (target 2:45, hard limit 2:55)

> **Rewritten Nov 7.** The app was rebuilt around four destinations (Overview / My Contracts /
> Add Contract / How It Works) plus a five-tab workspace per contract. The old screens the previous
> script drove — "Check a transaction", "Browse mirror", "Monitored contracts" — **no longer
> exist**. Liveness also moved from a 10-minute entity expiry to `checked_at` freshness (**5
> minutes**) plus a `dg_watcher_health` heartbeat, so moment (d) is now a **5-minute** wait, not 10.

## ⚠️ The hard constraint: under 3:00

Both EF CROPS ("3 minutes max") and 0G ("under 3 mins") cap the video at **3:00**. A 4-minute cut
disqualifies the two tracks it would be made for. **Target 2:45, absolute ceiling 2:55.** Every
line below is timed against that.

Rules: **your own voice**, a **laptop screen recording** (not a phone), **≥ 720p** (record 1080p),
**no speed-up**, no music under speech, no AI voiceover. Cuts are fine and used twice (marked ✂).
Never speed up a wait — cut it and say so.

---

## What has to be on screen, per track

| Track | The thing a judge must see |
| --- | --- |
| **0G** | A real inference in the main flow, with its **request id**, model and cost, and a reason to come back tomorrow |
| **Arkiv — mirror** | The registry mirrored and **filterable** (a query that returns the 3 stale attestations) |
| **Arkiv — from scratch** | `$creator` trust, freshness → NOT VERIFIED, entity keys as citations |
| **CROPS (lead: Security)** | The hash check **rejecting** tampered bytes, and failing closed with no stale green |

Four moments carry all four: **(a)** a descriptor from Swarm passes its hash check against Arkiv,
**(b)** corrupted bytes are **rejected**, **(c)** a live A→B upgrade turns the badge **RED** and
0G explains what changed, **(d)** a stopped watcher turns everything **NOT VERIFIED**.

---

## Recording plan: two clips

- **Clip 1** (0:00–2:05): problem → (a) → (b) → (c), including the 0G panel. One ✂ while the
  watcher catches up.
- **Off camera (~8 min):** switch the proxy back to A, let the watcher record it, **stop the
  watcher**, wait 6+ minutes.
- **Clip 2** (2:05–2:45): (d) → close.
- Then restart the watcher and re-baseline (see *After recording*).

---

## Script

### 0:00–0:18 · The problem (screen: How It Works, diagram visible)

> "Wallets use ERC-7730 descriptors to turn raw calldata into a readable intent — 'supply 100
> USDC' instead of hex. A descriptor is bound to a contract address. But 48% of the mainnet
> contracts in Ethereum's registry — 314 of 652 — are upgradeable proxies. After an upgrade, the
> wallet shows the same confident intent while different code runs behind it. Nothing in the
> registry records which implementation a descriptor was written for. Argos watches for that."

### 0:18–0:33 · What you'd actually use it for (screen: My Contracts)

> "You add the proxies you actually sign transactions to and accept a baseline once. From then on
> a watcher checks them every sixty seconds. This is the reason to open it tomorrow: on a normal
> day it's a two-second answer, and on the day something moves, it tells you what moved."

Point at the bell: *"changed and not-verified counts live here."*

### 0:33–1:05 · (a) + (b) Descriptor from Swarm, then rejected (screen: a contract → **Evidence**)

Open **Aave DAO** → **Evidence**. Point at the Arkiv records block.

> "Every claim has a record behind it. These are Arkiv entity keys — the baseline, the current
> state — and the two wallets Argos trusts. A row written by any other address isn't rendered at
> all."

Press **Verify now**.

> "That just fetched this descriptor's bytes **from Swarm**, by the reference stored on its Arkiv
> entity, and recomputed the keccak hash. It matches the ERC-8176 hash our writer published on
> Arkiv — that's the green line, source SWARM."

Tick **Demo: corrupt the bytes after download** → **Verify now**.

> "Now I corrupt one word after the gateway serves it — exactly what a compromised gateway or a
> network attacker could do. The hash no longer matches, and Argos renders **nothing**. Expected
> hash, actual hash, descriptor rejected. It does not fall back to another copy, because whoever
> broke the first one would get to choose the second."

Untick the box.

### 1:05–2:05 · (c) Live upgrade → RED, and 0G explains it (terminal + browser)

Terminal:

```bash
bash scripts/demo-upgrade.sh B
```

> "This is our own proxy on Sepolia. I'm upgrading it from implementation A to B through its
> ProxyAdmin, right now."

Wait for `implementation slot now: 0x1f31…` (~15 s).

✂ **Cut** (~60 s of waiting removed — keep the terminal clock or block number in shot across the
cut so it's visibly a cut, not a speed-up).

Browser: **My Contracts** → the demo proxy → it is **RED**.

> "One watcher cycle later: change detected. Baseline A, current B, the block, and a link to the
> upgrade transaction."

Open the **Investigate Change** tab.

> "Detection is the easy half. The question a reader is actually left with is *what* changed — and
> this is where 0G is doing the work. The watcher recovered the function selectors from the
> **deployed bytecode** of both implementations — no block explorer, no verified source, so it
> works on unverified contracts — diffed them, and asked a model on **0G Private Computer** to
> describe the difference."

Point at the footer.

> "Model, the **0G request id**, the provider, and what it cost — about a tenth of a cent. The
> sentences themselves live on Swarm; Arkiv carries their keccak hash, and the browser renders
> them only if they hash to that value. So a gateway can't put different words in the model's
> mouth. And notice what it never says: safe, unsafe, malicious, benign. A description, never a
> verdict — an AI confidence score would be the same unearned confidence this project exists to
> warn about."

*(If the call surface is unchanged, add 4 s: "Here the selectors are identical — same call surface,
different code. That's the worst case for clear signing, because nothing in a wallet's UI would
look any different.")*

**End of clip 1.**

### Off camera (≈ 8 minutes)

```bash
bash scripts/demo-upgrade.sh A
```

Wait for the watcher to log a `"change"` line back to `0xcea0…` (~70 s). Then **Ctrl+C** the
watcher and note the time. Wait **at least 6 minutes** (freshness is 5).

### 2:05–2:35 · (d) Watcher stopped → NOT VERIFIED (terminal + browser)

Show the stopped watcher terminal with its last timestamp.

> "I stopped the watcher six minutes ago — that's its last line."

Browser: **Overview** → refresh.

> "Every contract now reads **Not verified**, with the reason: no live watcher record. Not a stale
> green. A reading older than five minutes stops counting, so if the watcher dies, gets censored,
> or runs out of gas, you see that instead of a badge nobody is backing. The baselines, the change
> history and the registry mirror are all still there — only the liveness went."

Optional, 5 s, terminal — this is the strongest Arkiv-track line if you have room:

```bash
node scripts/show-arkiv.ts
```

> "And you don't need our UI to check any of it. This is keyless, reads the same Arkiv rows, and
> derives the same verdicts — including the heartbeat saying how long it's been since anyone
> watched."

### 2:35–2:45 · Close (screen: How It Works)

> "The whole ERC-7730 registry is mirrored to Arkiv — 771 descriptors, 2,678 deployments,
> filterable; importing it turned up three auditor attestations that no longer match their files.
> Descriptor content is on Swarm, the app itself is published to Swarm so it outlives our host,
> the trusted writers are public, and it's MIT. Argos watches, verifies, and warns — and never
> tells you something is safe."

---

## Before recording (exact commands)

Run from the repo root, one terminal per numbered block.

1. **Up to date and green**
   ```bash
   git pull && npm ci && npm run typecheck && npm test
   ```
2. **One watcher, in a visible terminal** so Ctrl+C works on camera. Kill any stray one first —
   **two watchers at once previously created duplicate Arkiv rows and a false green**:
   ```bash
   pkill -f 'watcher/src/main.ts' ; node --env-file=.env watcher/src/main.ts
   ```
   Within ~2 min it prints `"cycle"` lines for chain 1 and 11155111 with `"failed":0`. No `| tee`:
   Ctrl+C would kill tee first and hide the watcher's last line.
3. **Proxy at ImplA with a clean baseline** (removes any "previously changed" note):
   ```bash
   bash scripts/demo-upgrade.sh A        # only if the slot isn't already 0xcea0…910f
   npm run rebaseline -w watcher -- --chain 11155111 --address 0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5 --kind eip1967 --reason "clean state before demo video"
   ```
4. **Everything fresh and verified:**
   ```bash
   node scripts/show-arkiv.ts | grep -c 'VERIFIED (no change'      # → 32
   node scripts/query-mirror.ts stale                              # → 3 rows
   ```
   **Known state, decide before you record:** of 33 baselines, **32 read VERIFIED** and one
   Sepolia contract — `0x319480a00314b03453d1f43b96ecc9f1c4f6ef1d`, an old test proxy — reads
   **CHANGE DETECTED**, because it genuinely was upgraded and never rebaselined. It also holds the
   one leftover duplicate `dg_current_state` row from the two-watcher incident, which
   `show-arkiv.ts` now reports in its header. Nothing here is wrong, but if you'd rather the
   Overview read clean on camera, rebaseline it first:
   ```bash
   npm run rebaseline -w watcher -- --chain 11155111 --address 0x319480a00314b03453d1f43b96ecc9f1c4f6ef1d --kind eip1967 --reason "clean state before demo video"
   ```
   Leaving it is also a fair demo — it shows a real change the watcher caught, with its upgrade
   transaction.
5. **Dev server:**
   ```bash
   npm run dev     # http://localhost:5180
   ```
   Open in Chrome. Then **off camera**, open the Aave contract's Evidence tab once and press
   **Verify now**, so the mirror is cached (the first read pulls ~3,450 rows, ~10 s) and the Swarm
   fetch is warm. Confirm the row reads **SWARM**, not REGISTRY — if it says REGISTRY, Swarm is
   unreachable from your network and moment (a) loses its point.
6. **Sepolia gas:** the deployer needs ~0.001 ETH per upgrade.

## Recording checklist

- [ ] Recorder at **1920×1080**. Mic tested. No music under speech.
- [ ] Browser zoom **110–125%**, bookmarks hidden, other tabs closed, notifications off.
- [ ] Terminal font ≥ 16 pt. **No `.env` on screen**, no `cat .env`, no key in any command line.
- [ ] Clip 1 ≤ 2:05, clip 2 ≤ 0:40, total **≤ 2:55**. No speed-up anywhere.
- [ ] Hashes, the 0G request id, and the "Not verified" reason are legible at 720p.
- [ ] Put the (a)–(d) timestamps into `docs/SUBMISSION.md` and `arkiv/swarm.md`.

## After recording

```bash
node --env-file=.env watcher/src/main.ts          # restart, wait for "cycle" lines
npm run rebaseline -w watcher -- --chain 11155111 --address 0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5 --kind eip1967 --reason "clean state after demo video"
node scripts/show-arkiv.ts | grep -c 'VERIFIED (no change'    # → 33 within ~3 min
```

## If something fails on the day

| Problem | Do this |
| --- | --- |
| Swarm gateway down (Evidence row says REGISTRY) | Still record (a)/(b) — the hash check is the point and the fallback is also hash-checked. Say "Swarm is unreachable right now, so this came from the pinned registry commit and was checked the same way." |
| No `dg_change_note` on the demo proxy (0G failed) | Backfill before recording: `node --env-file=.env scripts/explain-change.ts --chain 11155111 --address 0xb8E5… --write`. Check the watcher log for a `0G answered` line. |
| 0G returns `no_provider_for_trust_mode` | The API key's Trust mode is **Verified**; most models need **Standard**. Switch it in the 0G dashboard and retry. |
| Upgrade tx stuck | `bash scripts/demo-upgrade.sh B` again (idempotent), or record (c) against the guard demo proxy `0x3c93…D669`. |
