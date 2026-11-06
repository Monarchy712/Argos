# Argos — finalist pitch (4 min live) and hard questions

## Before you walk on

- Watcher running, `node scripts/show-arkiv.ts | grep -c '"matches_baseline": true'` → **32**.
- Demo proxy at ImplA with a clean baseline (see `docs/VIDEO_SCRIPT.md` → *Before recording*, steps 2–4).
- `npm run dev`, Chrome at 125% zoom. Open the tabs in order: **How it works**, **Check a
  transaction** (mirror already cached: click Check once backstage), a terminal for
  `bash scripts/demo-upgrade.sh B`.
- Fallback if the venue network dies: the recorded video, plus the screenshots/log in
  `docs/TEST_REPORT.md` (Test 1, Test 3, E2E).

## 4-minute live demo

| Time | Screen | Say / do |
| --- | --- | --- |
| 0:00–0:30 | How it works (diagram) | "Clear signing turns calldata into a sentence you can read. The sentence comes from an ERC-7730 descriptor, and the descriptor is bound to an **address**. For a proxy, the address survives an upgrade. **48% of mainnet registry contracts (314 of 652) are proxies**, and the registry records no implementation for any of them. So after an upgrade, your wallet shows the same confident sentence for code nobody reviewed. The registry team lists an external monitor as one fix (#3098). We built it." |
| 0:30–0:50 | Diagram | "Three parts. The importer mirrors the whole registry to **Arkiv**: 3,443 rows, queryable. Descriptor content goes to **Swarm**. A watcher records each proxy's code at a baseline and publishes current state with a 10-minute expiry. The app checks everything and holds no keys." |
| 0:50–1:30 | **Check**: Aave supply | Load the Aave example → Check. "Raw calldata, readable intent: supply 100 USDC. The descriptor came from **Swarm** by the reference on its Arkiv row, and its bytes hash to the ERC-8176 hash our writer published. Green means our watcher's fresh record **and my own live slot read** both match the baseline, as of this block. Not 'safe'." Click the **dg_descriptor entity** link: "public, and you can see who wrote it." |
| 1:30–1:50 | Check, tamper on | Tick tamper → Check. "Change one word in the downloaded bytes: rejected, expected vs actual hash, nothing rendered. A mismatch never falls back to another copy." Untick. |
| 1:50–2:50 | Terminal → Check → Monitored | `bash scripts/demo-upgrade.sh B` (≈15 s). "Live upgrade of our Sepolia proxy, A to B." Check → *Demo proxy: increment()* → **RED**: "my live read already sees B." While the watcher catches up (~70 s), switch to **Browse mirror**: Monitored only → Query: "every filter is an Arkiv query; here's the query text; every row links to its Arkiv entity and Swarm bytes." Back to **Monitored → Refresh**: row is RED with block and tx link. "We never say malicious. We say: check that the descriptor still describes this code." |
| 2:50–3:30 | Monitored (talk, no live wait) | "What if our watcher dies? Its records **expire** after 10 minutes and every contract turns **Not verified**. We show that in the video. A database row would keep saying OK forever. On Arkiv, liveness is enforced by storage, and trust is two published `$creator` keys, not our server. We don't have a server." |
| 3:30–4:00 | How it works → Check it yourself | "Who's it for: wallets rendering ERC-7730 (the reference library is at 4,300 downloads a month), registry maintainers and auditors deciding what to re-review (we already found **3 stale attestations**), and anyone about to sign. It's MIT, it runs from the repo with no keys, and it's live now on 30 mainnet registry proxies plus two Sepolia demo proxies. Argos watches, verifies and warns." |

After the demo: `bash scripts/demo-upgrade.sh A` so the next judge sees green (then rebaseline when you can).

---

## The 20 hardest questions

**1. Can't wallets just simulate the transaction?**
Simulation tells you what this call does to state *now*. It doesn't tell you whether the
*descriptor* (the sentence the user reads) was written for the code that runs now. A post-upgrade
contract can simulate cleanly and still mean something different from its descriptor. Many signers
(hardware wallets) can't simulate at all; #3098 notes devices may not support on-device detection.
Simulation and Argos are complementary: one checks effects, the other checks that the explanation is
still bound to the reviewed code.

**2. What about Sourcify / Onay?**
Sourcify verifies source code and co-maintains the clear-signing tooling and registry process.
That's how descriptors get *in*. Argos watches what happens *after*: whether the code behind an
accepted descriptor changes. Our mirror's proxy classification and change history are inputs their
tooling could consume. We'd rather plug into it than compete. *(Check what "Onay" refers to before
judging; we found no public description of it, so don't characterise it beyond this.)*

**3. TOCTOU: the upgrade can land between your check and my transaction.**
Yes, and we say so in the README. A status is "as of block N". Argos narrows the window (event +
slot detection within about a minute, plus a live read at check time) but can't close it from
outside the transaction. Closing it needs a check in the same transaction. We built a **controlled
demo** of that on our own Sepolia proxy: the proxy's fixed code reports its implementation, and
`ArgosGuard.checkAndCall` reverts if it isn't the Argos baseline (`scripts/guard-demo.ts`, Check →
Guard demo proxy). It needs a proxy that exposes that getter (no registry contract does), and the
target sees the guard as sender, so for real use a wallet would do the check from the user's own
account. We don't claim it protects registry contracts.

**4. Why Arkiv and not Postgres?**
Three things a database can't give users without trusting us: (1) **expiry** enforced by storage,
so a dead watcher becomes Not verified instead of a permanent "OK"; (2) **`$creator`** on every row,
so clients verify who wrote it without our server; (3) a **public, keyless, queryable** copy that
survives us and that anyone can rebuild (`--dry` import) or audit (`npm run verify`). See
`arkiv/why-arkiv.md`.

**5. Who runs the watcher? Isn't that centralised?**
Today, us: one process, one key, and we say that in the CROPS section. The design limits the damage:
the watcher key can't write baselines, its records expire, and the user's live read cross-checks it.
Anyone can fork and run a watcher with their own keys on the same public schema. Requiring two
watchers to agree is a small client change we haven't built.

**6. What if your watcher lies?**
It can't make a changed contract look unchanged to a user who checks: the app's own live read of
the implementation slot must match the baseline, and any mismatch is RED. It could claim a change
that didn't happen (a false RED), which is visible and checkable on-chain from the tx link. A
watcher that just goes quiet turns everything Not verified. The baseline itself comes from the
separate writer key.

**7. What if your writer key is compromised?**
Then baselines could be replaced. Mitigations today: keys only in a gitignored `.env`, separate
watcher key, every rebaseline records a reason and the previous baseline key on Arkiv (an audit
trail anyone can read). The real fix is multiple independent writers, or baselines anchored to the
registry's own auditor attestations, which is roadmap.

**8. Why only 30 mainnet contracts?**
A deliberate cap for the event: RPC reads and Arkiv write budget. We picked the attested descriptors
first, plus every beacon and diamond kind. Extending to all 314 proxies is RPC cost plus one batched Arkiv
write per cycle; no design change.

**9. Diamonds, beacons, Safes, metamorphic contracts?**
EIP-1967 implementation, beacon (slot + `implementation()`), diamond (loupe facets hash) and Safe
singleton are read. Codehash is part of the identity, so a same-address redeploy is caught. Anything
we can't read is **Not verified: unsupported**, never green.

**10. Why is the descriptor on Swarm if it's already on GitHub?**
So the content doesn't depend on one company's CDN, and so one hash covers everything: we upload the
resolved JCS bytes, whose keccak *is* the ERC-8176 hash auditors sign. Fetching from Swarm and
checking that hash proves "right bytes" and "the descriptor auditors mean" in one step. GitHub stays
as a labelled fallback, hash-checked too.

**11. Whose Swarm postage batch?**
Honest answer: uploads went through the public gateway, which stamps them itself and doesn't tell
us its batch or retention (*update this if the booth batch was used: `--restamp`*). References are
content addresses, so re-stamping under our own batch doesn't change a single Arkiv row.

**12. Isn't the browser's Arkiv read a privacy leak?**
It reveals your IP to the Arkiv node, but not which contract: every visitor sends the same bulk
queries and filters locally. The README has a table of what each third party learns. Live chain
reads are direct by default and labelled "not anonymized".

**13. You targeted Anon-RPC and it didn't work. Why should we believe the privacy story?**
We don't sell a privacy story; Security is the lead. Nym's worker wouldn't boot for most of the
event — two networks, three harness versions — so we shipped direct-and-labelled rather than
silently-broken. It then started working on a retest: 4 of 5 cold boots, 60/60 reads, p95 2.4–3.6 s,
and a full Check with both the chain read and the Swarm descriptor fetch over the mixnet. You can
run that yourself on the Nym diagnostics tab. We kept direct as the default on the numbers, not the
mood: 10–14 s to boot, ~15 s for the first read, 1 boot in 5 failing. Nym is one click away, labelled,
and fails closed — it never falls back to direct silently.

**14. How do you know your mirror is correct?**
Every ERC-8176 hash is computed twice (our JCS and the reference library); any mismatch aborts.
Counts match the registry, and a verifier re-checks 10 random files against GitHub raw on every run
(10/10 twice today). Our pin equals upstream `master`.

**15. How does it stay current?**
The importer is idempotent: re-run on a new commit and it adds new rows and patches unchanged ones,
never deletes, and old versions remain as history. Today it's run by hand; a scheduled job on upstream
pushes is next. Long-lived rows are renewed by `npm run renew` (a patch never extends expiry on
Arkiv).

**16. What's the "3 stale attestations" finding exactly?**
Three descriptors in the registry have auditor signatures in `sigs/` over a *different* hash than
the current file's ERC-8176 hash: `safe/calldata-SafeMigration-1.5.0`, `safe/eip712-Safe-Multisig`,
`walletconnect/calldata-wct`. A wallet that enforces attestations would reject them until they're
re-attested. One query: `node scripts/query-mirror.ts stale`.

**17. Does RED mean the upgrade is malicious?**
No, and the UI never says it. Most upgrades are routine. RED means the code changed since the
descriptor was bound to it, so someone should check that the descriptor still describes it.

**18. Who actually uses this after Mumbai?**
Wallet teams integrating `@ethereum-sourcify/clear-signing` (one Arkiv query next to the rendered
intent), registry maintainers and auditors (which attested descriptors sit on changed code), and
security dashboards. Concrete next step: propose the schema in #3098/#2975 and a ~20-line status
snippet for the library's docs. See `arkiv/reach.md`.

**19. What about EIP-712 descriptors?**
They're mirrored (129) and their deployments are monitored like any other proxy. The extra check in
#2975, whether the EIP-712 *domain* changed on upgrade, is our clearest next feature; not built.

**20. Why should this be a protocol-level data set and not a feature inside one wallet?**
Because the evidence should be the same for every wallet and checkable by anyone. If each wallet
runs its own private monitor, users can't compare, and small wallets can't afford one. On Arkiv
it's one public data set with a published writer, which any wallet can read, and any team
can run its own watcher next to ours.

### If you get a question you can't answer
"I don't know yet. Here's how I'd find out." Then name the file or query. Don't guess numbers;
everything we quote is in `UPDATES.md`, `docs/TEST_REPORT.md` or `arkiv/*.md`.
