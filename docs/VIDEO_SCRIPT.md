# Argos — demo video script (target 2:40, hard limit 2:55)

Rules we follow (ETHGlobal + EF CROPS): **your own voice**, a **laptop screen recording** (not a
phone), **≥ 720p** (record 1080p), **no speed-up**, no music with text, no AI voiceover, and
**≤ 3:00** for the EF CROPS prize. Cuts are fine and used twice (marked ✂). We never speed up a
wait; we cut it and say so.

The four moments the judges need to see: (a) a descriptor **fetched from Swarm** passes its hash
check against Arkiv, (b) a **tampered** descriptor is rejected, (c) a **live A→B upgrade** turns the
badge **RED**, (d) a **stopped watcher** makes the status expire to **NOT VERIFIED**.

Measured rehearsal timings (Nov 6, 09:24 IST): the upgrade tx mined in **14 s**. The watcher
wrote the RED record **~70 s** after the tx. A stopped watcher's rows show *stale* after 5 min
and are **gone from Arkiv after 10 min** (expiry).

---

## Recording plan: two clips

- **Clip 1** (0:00–1:55): problem → (a) → (b) → (c). One take, one ✂ while the watcher catches up.
- **Off camera, ~12 min:** switch the proxy back to A, let the watcher record it, **stop the
  watcher**, wait 10+ minutes.
- **Clip 2** (1:55–2:40): (d) → close.
- Then restart the watcher and re-baseline (see *After recording*).

---

## Script

### 0:00–0:15 · Problem (screen: How it works tab, diagram visible)

> "Wallets use ERC-7730 descriptors to turn raw calldata into a readable intent. A descriptor is
> bound to a contract address. But 48% of the mainnet contracts in the registry, 314 of 652, are
> upgradeable proxies. After an upgrade the wallet still shows the same confident intent, while
> different code runs. Argos watches for that."

### 0:15–0:45 · (a) Descriptor from Swarm, hash-checked against Arkiv (screen: Check a transaction)

Action: *Load an example… → Aave v3: supply 100 USDC* → **Check transaction**. Point at the three
parts top to bottom.

> "Here's an Aave supply. Raw calldata at the top, and the readable intent: supply 100 USDC. The
> descriptor came from **Swarm**, by the reference stored on its Arkiv entity, and its keccak hash
> matches the ERC-8176 hash our writer published on Arkiv. That's this line: Swarm, check mark.
> The badge is green because our watcher's record on Arkiv is fresh and my own live read of the
> proxy's implementation slot matches the baseline. Green means no change as of this block, not
> 'safe'."

(Optional, 3 s: hover **dg_descriptor entity** / **Swarm 7d65ee6b…** links.)

### 0:45–1:05 · (b) Tampered descriptor rejected (same screen)

Action: tick **Demo: tamper with the downloaded descriptor** → **Check transaction**.

> "Now I tamper with the downloaded bytes, the way a compromised gateway or network could. One
> word changes, the hash no longer matches Arkiv, and Argos renders nothing: descriptor rejected,
> expected hash, actual hash. It doesn't fall back to another copy on a mismatch."

Action: untick the box.

### 1:05–1:55 · (c) Live upgrade A→B turns the badge RED (terminal + browser)

Action: switch to the terminal and run:

```bash
bash scripts/demo-upgrade.sh B
```

> "This is our demo proxy on Sepolia. I'm upgrading it from implementation A to B, through its
> ProxyAdmin, right now."

Wait for `implementation slot now: 0x1f31…` (~15 s; the helper then waits for 2 confirmations
before returning, which doesn't matter for the browser check). Switch to the browser: *Load an example… →
Demo proxy: increment()* → **Check transaction**.

> "Same check as before, on the proxy. Red: change detected. My live read already sees
> implementation B, which differs from the baseline."

✂ **Cut** (≤ 60 s of waiting removed; keep the terminal clock or block number in shot after the cut).

Action: **Monitored contracts** tab → **Refresh**. Point at the demo proxy row.

> "About a minute later the watcher has picked up the Upgraded event and written it to Arkiv:
> baseline A, current B, the block, and a link to the upgrade transaction. Argos doesn't say this
> upgrade is malicious. It says: check whether the descriptor still describes the code that runs
> now."

**End of clip 1.**

### Off camera (≈ 12 minutes)

```bash
bash scripts/demo-upgrade.sh A
```

Wait until the watcher terminal prints a `"change"` line back to `0xcea0…` (~70 s). Then press
**Ctrl+C** in the watcher terminal (it prints `stopping after current cycle`, or just exits when Git Bash kills it outright; either is fine) and note the time.
Wait **at least 10 minutes**.

### 1:55–2:25 · (d) Watcher stopped → NOT VERIFIED (terminal + browser)

Action: show the stopped watcher terminal with its last timestamp (e.g. "stopped at 21:14").

> "I stopped the watcher about ten minutes ago: that's its last line. Its Arkiv records were
> written with a ten-minute expiry, so they're gone now."

Action: **Monitored contracts** → **Refresh**.

> "Every contract now shows **Not verified**, with the reason: no live watcher record. Not a stale
> green. If the watcher dies, gets censored or runs out of gas, users see that, instead of a green
> badge nobody is backing. The baselines and the registry mirror are still on Arkiv; only the
> liveness expired."

### 2:25–2:40 · Close (screen: How it works → "Check it yourself")

> "Argos is for wallets that render ERC-7730, registry maintainers and auditors deciding what to
> re-review, and anyone checking a transaction before they sign. Everything is public on Arkiv and
> Swarm, the trusted writers are published, and it's MIT-licensed. Argos: it watches, verifies
> and warns."

---

## Before recording (exact commands)

Run from the repo root (`C:\Users\samya\OneDrive\Desktop\Argos`), Git Bash unless noted.

1. **Up to date and built**
   ```bash
   git pull && npm ci && npm run typecheck && npm test
   ```
2. **One watcher, in a visible terminal.** The live watcher currently runs in the background
   (started by Claude Code). Stop it, then start it in its own terminal tab so Ctrl+C works on
   camera. PowerShell, to find it (also lists a leftover test watcher, PID 25700, file sink only):
   ```powershell
   Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object CommandLine -like '*watcher/src/main.ts*' | Select-Object ProcessId,CommandLine
   ```
   Stop each listed PID (`Stop-Process -Id <pid>`), then in a new terminal tab:
   ```bash
   node --env-file=.env watcher/src/main.ts
   ```
   Within ~2 min it prints `"cycle"` lines for chain 1 and 11155111 with `"failed":0`. (No `| tee`:
   Ctrl+C would kill tee first and hide the watcher's last line.)
3. **Proxy at ImplA and a clean baseline** (removes the "previously changed" note from rehearsals):
   ```bash
   bash scripts/demo-upgrade.sh A        # only if the slot isn't already 0xcea0…910f
   npm run rebaseline -w watcher -- --chain 11155111 --address 0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5 --kind eip1967 --reason "clean state before demo video"
   ```
4. **All 32 fresh:**
   ```bash
   node scripts/show-arkiv.ts | grep -c '"matches_baseline": true'    # → 32
   ```
5. **Dev server:**
   ```bash
   npm run dev     # http://localhost:5180
   ```
   Open it in Chrome; header pill says **Live reads: direct RPC (not anonymized)**. Click **Check transaction**
   once off camera so the mirror is cached (first load reads ~3,400 rows, ~8 s).
6. **Sepolia gas:** the deployer needs ~0.001 ETH per upgrade (it had 0.013 ETH on Nov 6).

## Recording checklist

- [ ] Screen recorder at **1920×1080** (Windows: Xbox Game Bar Win+Alt+R records one window; OBS for
      browser + terminal). Mic tested, no music.
- [ ] Browser zoom **110–125%**, bookmarks bar hidden, other tabs closed, notifications off (Focus).
- [ ] Terminal font ≥ 16 pt, two tabs: watcher, and one for `demo-upgrade.sh`. **No `.env` on screen**,
      no `cat .env`, no key in any command line (the helper reads it from `.env`).
- [ ] Clip 1 under 1:55, clip 2 under 0:45, total **≤ 2:55**. No speed-up anywhere.
- [ ] Say "cut" points out loud only if you'll edit them out; otherwise narrate the wait honestly.
- [ ] After export: watch once at 1×, check the hashes and the "Not verified" reason are legible at 720p.
- [ ] Put the timestamps of (a)–(d) into `arkiv/swarm.md` (Swarm moment = (a)) and `docs/SUBMISSION.md`.

## After recording

```bash
# restart the watcher (new terminal tab) and wait for "cycle" lines
node --env-file=.env watcher/src/main.ts
# clean baseline again so judges see a plain green row
npm run rebaseline -w watcher -- --chain 11155111 --address 0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5 --kind eip1967 --reason "clean state after demo video"
node scripts/show-arkiv.ts | grep -c '"matches_baseline": true'    # → 32 within ~3 min
```
