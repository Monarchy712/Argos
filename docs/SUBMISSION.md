# Argos — ETHGlobal Mumbai submission text

Copy each block into the matching field of the ETHGlobal form. Prize picks:
1. **Arkiv** — **Mirror something Ethereum depends on** (the ERC-7730 registry), plus the Arkiv +
   Swarm bonus, which doesn't use a pick ("Each team can win one Arkiv track prize; the bonus can
   come on top of it").
2. **Arkiv** — **Build on Arkiv (from scratch)**. Submitted as well, since the app's own data
   (baselines, observations, change notes, heartbeat) lives on Arkiv and is read by features users
   see. Arkiv's rule caps us at **one Arkiv prize**, so this is the second of two Arkiv entries,
   not a second prize. Criterion file: `arkiv/how-you-use-arkiv.md`.
3. **Ethereum Foundation** — **Best CROPS App** (lead property: Security). EF's rule: "One EF
   prize per project. You can submit to anon-rpc, the alt mempool and CROPS, but you will be placed
   in at most one." We spend the single EF pick on CROPS, which is what Argos actually is.
4. **0G** — Build with 0G Private Computer. Inference runs in the main user flow — the watcher
   calls it automatically on every detected change — with the request id on every result.

- Repo: https://github.com/Monarchy712/Argos (MIT)
- Demo video: VIDEO_URL (fill in after upload)
- Built from scratch at ETHGlobal Mumbai, Nov 5–7 2026. AI usage: [AI_USAGE.md](../AI_USAGE.md).

---

## Project name

Argos

## Short description (≤ 100 characters)

Detects when the code behind an ERC-7730 clear-signing descriptor changes; publishes it on Arkiv.

## Description

Wallets use ERC-7730 descriptors to turn raw calldata into a readable intent ("Supply 100 USDC").
A descriptor is bound to a contract address. For an upgradeable proxy, that address stays the same
when the code behind it is replaced. The wallet keeps showing the same confident, readable intent
while different code runs. We classified every mainnet contract in the EF's ERC-7730 registry:
**314 of 652 (48%) are upgradeable proxies**, and the registry records no implementation binding
for any of them. The registry maintainers list an external monitoring tool as one answer (issue
#3098).

Argos is that monitor. It:

- **mirrors the whole ERC-7730 registry to Arkiv**: 771 descriptor rows and 2,678 deployment rows,
  queryable by chain, address, protocol, kind, proxy kind and attestation status. The descriptor
  content is on **Swarm**, referenced from each Arkiv row and verified by its ERC-8176 hash;
- records each monitored contract's code identity at a **baseline**, and runs a **watcher** that
  detects upgrades (events plus slot reads) on 33 contracts (30 mainnet registry proxies plus
  Sepolia demo proxies). It publishes `current_state`, `latest_change` and a `dg_watcher_health`
  heartbeat on Arkiv;
- lets anyone add their own proxy in a static web app — Argos inspects it, shows the evidence, and
  asks *you* to accept a baseline — then reports a status on every visit:
  **Verified · no change**, **Change detected**, or **Not verified**;
- explains, via **0G Private Computer**, what changed about the call surface when a change is
  detected — a description, never a verdict, with the 0G request id attached.

Security is the point. A descriptor is rendered only if its bytes hash to the value our writer
published on Arkiv; tampered bytes are rejected. Status comes from two published Arkiv `$creator`
keys plus the user's own live read of the proxy slot. A watcher reading goes stale after 5
minutes, and the watcher publishes a heartbeat entity, so a dead or censored watcher shows
**Not verified** with the reason, never a stale green.
Importing the registry also surfaced **3 stale auditor attestations**, which sign different content
than the current files.

Argos detects, verifies and warns. It doesn't block transactions, doesn't guarantee safety, and
never calls an upgrade malicious.

## How it's made

TypeScript end to end, Node 24, npm workspaces, everything exact-pinned.

- **Arkiv** (`@arkiv-network/sdk@1.0.1`, Rabdi testnet): eight typed schemas (`dg_*`). The
  **importer** reads the registry at a pinned commit, resolves `includes` with
  `@ethereum-sourcify/clear-signing`'s merge, computes each ERC-8176 hash twice (our RFC 8785 JCS +
  keccak, and the library's) and aborts on any mismatch. It compares the hashes with auditors'
  signed attestations and classifies every mainnet deployment on-chain (EIP-1967, beacon, diamond
  loupe, Safe). Writes are idempotent and resumable, in `executeBatch` transactions of 20 that halve on
  HTTP 413: 3,449 rows for 1.65 tGLM. A client-side verifier re-checks counts and 10 random files
  against GitHub raw.
- **Swarm** (`@ethersphere/bee-js@13.2.0` + the public gateway): we upload the *resolved* descriptor's
  JCS bytes, so one keccak hash proves both "Swarm returned the right bytes" and "this is the
  ERC-8176 descriptor auditors sign". Each upload is read back and checked before its reference is
  patched onto the Arkiv row. References are unencrypted; descriptors are public CC0 data.
- **Watcher**: scans `Upgraded` / `AdminChanged` / `BeaconUpgraded` / `DiamondCut` from a persisted
  cursor and reads the slots every 60 s (A→B→A stays flagged). It writes a contract's `current_state`
  and `latest_change` atomically in one batch, plus a `dg_watcher_health` heartbeat per chain.
  Entities are long-lived (~182 days, renewed) and freshness comes from `checked_at` against a
  300 s line — retention, liveness and freshness are three separate things, which they were not in
  our first design. The watcher key can't write baselines; a separate writer key does. It also
  calls 0G on each detected change, after the change is already on Arkiv.
- **Web app** (Vite 8 + React 19, static, no backend, no keys, no analytics): one bulk,
  contract-independent Arkiv read per page (so Arkiv can't tell which contract you check),
  Swarm-first descriptor fetch with a registry fallback that's shown on screen, ERC-7730 rendering by
  `@ethereum-sourcify/clear-signing`, a live code-identity read via viem, and risky-calldata flags
  (upgrades, `changeMasterCopy`, Safe delegatecall).
- **Contracts**: Foundry, an OpenZeppelin 5.6.1 transparent proxy on Sepolia that we upgrade live in the demo.
- **Hacky bits:** the Arkiv SDK puts the access key in the RPC URL, so every logged error is redacted.
  A Windows CRLF checkout changed every file hash; the browser's own integrity check caught it on its
  first run. The public Swarm gateway turned out to accept stampless uploads, which got content on
  Swarm before we had our own postage batch.
- **What we built and then removed:** Anon-RPC over Nym was the default transport for live reads.
  Its worker never became ready for most of the event (two networks, three harness versions); a
  retest later booted 4 of 5 times and served 60/60 reads at p95 2.4–3.6 s, and we never established
  what changed. Since EF places a project in at most one prize and Argos is a security tool, we spent
  the EF pick on CROPS and **removed the Nym integration** rather than ship a privacy path we could
  not explain. Live reads now go direct and every result says so. The write-up of the failure and the
  retest stays in `docs/TEST_REPORT.md`, because it is the useful feedback for the Anon-RPC team even
  though we are not submitting to that prize.

---

## Partner: Arkiv — Mirror something Ethereum depends on (+ Arkiv + Swarm bonus)

**How we use it.** We mirror the EF's ERC-7730 clear-signing registry: 771 `dg_descriptor` +
2,678 `dg_deployment` rows at the registry's current `master` commit, plus per-contract
`dg_baseline`, `dg_current_state`, `dg_latest_change`, `dg_change_note` and `dg_watcher_health`
from our watcher. Users read it in the app: **Add Contract** looks any address up in the mirror and
fetches its descriptor from Swarm by the `swarm_ref` on its Arkiv row, the **Evidence** tab cites
the entity key behind every claim and re-verifies the hash on demand, and the status badge comes
from the watcher's rows. Arkiv features map to what users see. **`checked_at` freshness** turns a
dead watcher into "Not verified" in 5 minutes. **`$creator`** decides which rows are trusted.
**Indexed queries** power the registry lookups and `scripts/query-mirror.ts`. **Expiry** means
nothing we stop renewing outlives us by more than ~182 days. **Public ownership** lets anyone
re-run the import or the verifier.
Writer `0x623EdFf351EB13aCCFc56cBf541eE4D45BDADCf4`, watcher `0x8a883182b488cE04f08D348C64d9AC8EecACF2Bf`.
One query: `node scripts/query-mirror.ts stale`.
Docs: `arkiv/schema.md`, `how-you-use-arkiv.md`, `friction.md`, `reach.md`, `why-arkiv.md`, `data-quality.md`, `swarm.md`.

**Swarm bonus.** Swarm holds the content: the resolved bytes of all 746 descriptors. Arkiv holds the
facts, and `dg_descriptor.swarm_ref` points from one to the other. The browser fetches from Swarm and
renders only if keccak256(bytes) equals the Arkiv row's ERC-8176 hash. The tamper demo shows a
rejection. Example: entity `0x495d23d3…dee4f8` → `api.gateway.ethswarm.org/bytes/7d65ee6b…f63a04`.

**Feedback (Arkiv).** The typed `defineSchema` API caught real mistakes at compile time, and
`executeBatch` with mixed creates, patches, deletes and extensions gave us atomic writes. Expiry as a
first-class feature *is* our liveness signal. What cost us time:
(1) docs and examples still pointing at SDK 0.8 and the Tiramisu testnet, which can't write to Rabdi;
(2) the keyless cost budget isn't documented, and viem's retries hid the 429 as a hang;
(3) the access key travels in the URL path, so stack traces leak it;
(4) `executeBatch` reports HTTP 413 as "execution error without revert data";
(5) `patchEntity` never extends expiry, which is correct but easy to miss.
Details and reproduction steps: `arkiv/friction.md`.

**Feedback (Swarm).** Content addressing made the importer idempotent for free, and the gateway's
`Access-Control-Allow-Origin: *` let the browser read Swarm directly. Getting our own postage
batch (xDAI + xBZZ on Gnosis plus a light node) wasn't doable in an hour at the venue. The public gateway
accepted stampless uploads, but doesn't say whose batch it used or how long it keeps the data. bee-js
`data.upload` requires a batch ID, so it can't express that path. Details: `arkiv/swarm.md`.

## Partner: Arkiv — Build on Arkiv (from scratch)

**Why this track too.** The mirror is a copy of someone else's data. Everything *Argos itself*
produces also lives on Arkiv, and that is what this entry is about: `dg_baseline` (the trust
anchor a reviewer accepts), `dg_current_state` (every observation, with `checked_at`),
`dg_latest_change`, `dg_change_note` (the facts behind a 0G explanation) and `dg_watcher_health`
(the heartbeat). There is no database behind the app, and no backend at all.

**Do the filters, owners and expiry fit the app?** Full answer with a table per question:
`arkiv/how-you-use-arkiv.md`. In short: two `$creator` wallets with the watcher deliberately
unable to write baselines; every indexed field is reached by a filter a user can trigger; and
retention, liveness and freshness are three separate mechanisms after we found that collapsing
them into entity expiry destroyed the history we needed.

**Does each Arkiv feature change something users see?**
- `$creator` → a row from any other wallet is never rendered; the two addresses are on screen.
- `checked_at` freshness → stop the watcher and every contract reads **Not verified** in 5 minutes.
- `dg_watcher_health` → `scripts/show-arkiv.ts` prints per-chain liveness before any contract, so
  a dead watcher is stated rather than inferred from missing rows.
- Indexed queries → **Add Contract** answers "is this address in the registry, and does its
  descriptor verify?" in one page load.
- `executeBatch` → a contract never renders half-updated.
- Entity keys → every claim in the **Evidence** tab links to the row it came from.

**What we kept off Arkiv, and why:** descriptor and explanation text (an Arkiv `str` caps at 128
bytes, so content goes to Swarm with its hash on Arkiv), a contract you added before a baseline
exists (it stays in your browser; publishing it would need our key and would reveal which
contracts you care about), anything per-user (entities are public, and a watchlist is a profile),
and verdicts — no row says "safe".

**The honest gap.** The trusted writer addresses are compiled into the client
(`packages/core/src/trust.ts`), so anyone can fork Argos and run their own watcher against the
same public schemas, but pointing a client at a different operator means a rebuild, not a setting.

One query: `node scripts/show-arkiv.ts`. Criterion files: `arkiv/how-you-use-arkiv.md`,
`arkiv/friction.md`, `arkiv/reach.md`, `arkiv/why-arkiv.md`, `arkiv/schema.md`.

## Partner: Ethereum Foundation — Best CROPS App (lead property: Security)

**How it fits.** Argos exists for **security** in the "verify, don't trust" sense. Clear signing
is only as trustworthy as the binding between a descriptor and the code it describes, and for
proxies that binding silently breaks. Argos makes every claim checkable. Descriptor bytes must
match a hash published on Arkiv. Status comes from published keys plus the user's own live read.
A missing or dead watcher fails closed to "Not verified" because a reading older than 5 minutes
stops counting — arithmetic any reader can redo on public rows we cannot retroactively edit. The other three properties, with honest trade-offs:
**C:** static app, public data on Arkiv and Swarm; if our watcher stops or refuses you, you see Not verified with the reason, not a stale green — censoring us produces a visible absence, never a false green, and `dg_watcher_health` records when we stopped. The built app is itself published to Swarm (`scripts/publish-site.ts`, reference in `arkiv/swarm.md`), so the frontend survives our host; the honest gap is that the trusted writer addresses are compiled in, so replacing us means a rebuild.
**O:** MIT, builds and runs from the repo with no keys.
**P:** no trackers, no analytics, and no third-party assets — fonts and icons are served from this
origin, so visiting the page contacts nobody but the endpoints the app needs. Arkiv reads are keyless
and go out as one bulk, contract-independent query, identical for every visitor, so the Arkiv node
learns an IP and never which contract you opened. Live chain reads and Swarm descriptor downloads go
direct, which means those providers do see your IP and the contract — the app labels every result
`direct RPC, not anonymized` rather than implying a protection it does not have. The full CROPS
section and a per-third-party privacy table are in the README.

**Feedback for the Anon-RPC team (not a prize submission — we removed the integration; see above).** The specifier lookup, the 18 MB bundle download and its hash check
all worked. The Nym worker then hung silently, with no log lines and no console errors, on venue
Wi-Fi and a phone hotspot, with harness 0.4.0, 0.3.3 and 0.3.2 — and then, hours later, the same
code booted fine 4 times out of 5 and served 60/60 reads at p95 2.4–3.6 s. We could explain neither
the failure nor the recovery, which is the actual feedback: a boot-progress log, or a harness-level
boot timeout that reports the last phase reached, would have turned an hour of guessing into a bug
report. (One boot in five died with `Failed to fetch` on the bundle download — that error *is*
legible and retryable, and we'd like the tunnel to fail the same way.) Arkiv's RPC didn't answer
through the Nym exit in our spike either, so mixed anonymized/direct apps need endpoint support on
both sides. Details: `docs/TEST_REPORT.md` (Test 4 and the retest above it).

---

## Partner: 0G — Build with 0G Private Computer

**What we built.** Argos detects that the code behind a clear-signing descriptor changed. Until
now it could not say *what* changed, and told the reader to go and check. 0G closes that gap: on
the change-detected path we recover the 4-byte function selectors from the **deployed bytecode**
of the old and new implementations, diff them, and ask a model on 0G Private Computer to describe
the difference in plain language.

**Inference is in the main user flow, with request ids.** The change-detected path is the whole
point of Argos, not a side feature. Every explanation carries the `x_0g_trace.request_id`, the
provider address and the cost, and all three are shown in the UI and stored on Arkiv, so any
claim can be traced back to the run that produced it. Example from a real run: request id
`1d20f02c-e851-4b6e-9a0d-72d3dc4de5fa`, provider `0x000000003f486c…`, $0.000914.

**What breaks if 0G is removed (one sentence).** Argos goes back to telling you *that* the code
changed and leaving you to disassemble two contracts yourself — detection survives, explanation
disappears.

**The deliberate limit: it describes, it never judges.** The model is instructed never to say
whether a change is safe, unsafe, malicious or benign, and the panel says so too. This was a
considered decision, not caution for its own sake: Argos exists because wallets show confident
intent while different code runs, so answering that with an AI confidence score would reproduce
the exact failure we are warning about — and it would be unfalsifiable, since there is no ground
truth for "safe". A factual diff is both more honest and more useful.

**Why bytecode and not verified source.** Verified source would have meant depending on a block
explorer and would fail for unverified contracts — including our own Sepolia demo
implementations. `eth_getCode` always works. We state plainly that PUSH4 scanning yields a
*superset* of the external ABI, not the ABI.

**How it composes with the rest of the stack.** An Arkiv `str` caps at 128 bytes, so the text goes
to **Swarm** and `dg_change_note` on Arkiv carries its keccak hash plus the facts. The browser
renders the words only if they hash to the value on Arkiv — the same integrity rule as
descriptors — so a gateway cannot put different words in the model's mouth. The app stays
keyless: `ZEROG_API_KEY` is read only by the script, never shipped to the browser.

**Honest feedback for 0G.** The API is genuinely drop-in — an OpenAI-shaped `POST
/v1/chat/completions` and it worked first try. One thing cost us real time: an API key's **Trust
mode** silently determines whether anything is reachable. On *Verified*, every mainstream model
returned `503 no_provider_for_trust_mode: tier=verified`, and the one model that did have a
verified provider (`0gm-1.0-35b-a3b`) returned `502 fetch provider quote: EOF` on every attempt.
Nothing in the key UI warns that choosing Verified leaves most of the catalogue unreachable, and
the failure only appears at inference time. Surfacing per-mode provider availability when the
mode is chosen would have saved us an hour. `x_0g_trace` is excellent — request id, provider and
billing in the response body is exactly what an auditable app needs, and we built our provenance
UI directly on it.

**Post-hackathon viability.** The watcher now invokes it automatically on every detected change
(`watcher/src/explain.ts`), which was the open item at the time of writing; the standalone script
remains for backfills. Cost is about $0.001 per explanation, which is affordable at the rate real
upgrades actually happen. The next step is per-user keys so a visitor spends their own 0G credits
instead of ours — see the iAI note below.

**iAI bonus — not implemented, stated plainly.** Argos holds no user accounts and ships no keys to
the browser: the 0G call is made server-side by the watcher, on a schedule, not by a signed-in
user pressing a button. Letting a visitor sign in with their 0G account and spend their own daily
credits would mean moving the inference to a user-triggered path in the browser, which we did not
build. We are not claiming this bonus.

---

## Video timestamps (fill in after recording)

| Moment | Time |
| --- | --- |
| Problem (48%) | 0:00 |
| (a) Descriptor from Swarm, hash-checked against Arkiv | |
| (b) Tampered descriptor rejected | |
| (c) Live A→B upgrade → RED | |
| (d) Watcher stopped → NOT VERIFIED | |
