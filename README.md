# Argos

Contract-change detection and verification for ERC-7730 clear-signing descriptors.
Argos **detects, verifies and warns**. It does not block transactions, does not guarantee
safety, and never calls an upgrade malicious.

*Argos is the hundred-eyed watchman of Greek myth. The project's working name was DriftGuard, so
Arkiv schemas use the `dg_` prefix and workspace packages are `@driftguard/*`. They were kept
on purpose: renaming them would orphan the records already on Arkiv.*

> Status: hackathon build in progress (ETHGlobal Mumbai, from-scratch track). Progress log:
> [UPDATES.md](UPDATES.md) · risk tests: [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

## Quick start (no keys needed)

```bash
git clone https://github.com/Monarchy712/Argos && cd Argos
npm ci
npm run dev                          # web app on http://localhost:5180
node scripts/show-arkiv.ts           # every monitored contract's status, read from Arkiv
node scripts/query-mirror.ts stale   # a query on the registry mirror
```

Requires Node ≥ 22.10. Reading needs no wallet or API key. Writing (watcher, importer) needs
keys in `.env`; see [Setup](#setup).

## Problem

An [ERC-7730](https://eips.ethereum.org/EIPS/eip-7730) descriptor tells a wallet how to show a
transaction to a contract in plain language. Descriptors are bound to `(chainId, address)`. For an
upgradeable proxy that address is the proxy. After an upgrade, the wallet still finds "the"
descriptor and still renders a confident, readable intent, while different code runs.

How common is this? We classified every mainnet deployment in the EF registry
([ethereum/clear-signing-erc7730-registry](https://github.com/ethereum/clear-signing-erc7730-registry)
@ `ef582c2`) by reading its proxy slots. **314 of 652 addresses (48%) are upgradeable proxies**
(284 EIP-1967, 28 beacon, 2 diamond), and the registry records no implementation binding for any
of them. Source: [`watcher/monitored-mainnet.json`](watcher/monitored-mainnet.json),
[`scripts/select-mainnet-proxies.ts`](scripts/select-mainnet-proxies.ts).

Argos records each monitored contract's code identity at a **baseline** and publishes, on
[Arkiv](https://arkiv.network), whether it still matches, whether it ever changed, and the latest
change with its transaction.

## How it works

```
registry ──► importer ──► Swarm: resolved descriptor bytes (746)  ◄── swarm_ref ── Arkiv: dg_descriptor (768) + dg_deployment (2,675)
chain ─────► watcher ───► Arkiv: dg_current_state (10-min expiry), dg_latest_change
writer ────► rebaseline ► Arkiv: dg_baseline (the trust anchor; never auto-replaced)
change ────► 0G ────────► Swarm: what-changed text ◄── summary_hash ── Arkiv: dg_change_note
browser ───► reads Arkiv once (bulk) + its own live slot read (Anon-RPC/Nym by default) → GREEN / RED / NOT VERIFIED
```

- **Watcher:** scans `Upgraded` / `AdminChanged` / `BeaconUpgraded` / `DiamondCut` events from a
  persisted block cursor, and reads EIP-1967 / beacon / loupe / Safe slots every 60 s. A→B→A
  stays flagged (`ever_changed_since_baseline`). If the watcher dies, its `current_state` rows
  expire within 10 minutes and clients show **NOT VERIFIED**.
- Full design, with every external claim marked VERIFIED or ASSUMED:
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Companion web app

```bash
npm ci && npm run dev    # http://localhost:5180
```

| Screen | What it does |
| --- | --- |
| **Monitored contracts** | One bulk Arkiv read per trusted writer (the same for every visitor, so Arkiv doesn't learn which contract you care about). Shows status badge, protocol, proxy kind, detection mode, baseline vs current implementation, latest change with tx link, and the ERC-8176 descriptor hash. |
| **Check a transaction** | Paste `{chainId, to, data}` or a raw transaction. Shows the raw calldata and the readable ERC-7730 intent. The descriptor's path, commit and hashes come from the **Arkiv registry mirror**, and the file is fetched and checked against them before `@ethereum-sourcify/clear-signing` renders it. Also shows risky-calldata flags (upgrades, `changeMasterCopy`, Safe `operation=1`) and a status from the watcher's Arkiv record plus a live code-identity read. When a change has been explained, a **"What changed in the code"** panel shows it (see below). |
| **Browse mirror** | Filter the mirrored registry by chain, protocol, descriptor kind, proxy kind and "monitored". Each filter is an Arkiv query, and the queries run are shown on screen. |
| **Nym diagnostics** | Boots the Anon-RPC Nym worker and runs Test 4: 20 slot reads with boot time, success count, HTTP statuses, p50/p95. Last run: 60/60 over three runs, p95 2.4–3.6 s. |

**What changed in the code (0G Private Computer).** Detecting a change leaves the reader with the
question Argos could never answer: *what* changed? When a change is recorded,
[`scripts/explain-change.ts`](scripts/explain-change.ts) recovers the 4-byte function selectors
from the **deployed bytecode** of both implementations (no block explorer, no verified source —
it works on unverified contracts), diffs them, and asks a model on **0G Private Computer** to
describe the difference in two to four sentences.

It is a description, **never a verdict**. The model is instructed not to say whether a change is
safe, unsafe, malicious or benign, and the panel repeats that. Argos does not decide whether an
upgrade is dangerous, and an AI confidence score would be the same unearned confidence this
project exists to warn about.

The text goes to **Swarm**; `dg_change_note` on Arkiv carries its keccak hash plus the facts —
which implementations, how many selectors moved, whether the call surface is unchanged, the
model, the **0G request id**, the provider and the cost. The browser renders the words only if
they hash to the value on Arkiv, exactly as it treats a descriptor. Run log:
[`docs/test-runs/zerog-explain-change.txt`](docs/test-runs/zerog-explain-change.txt).

`ZEROG_API_KEY` is read only by that script and is never shipped to the browser, so the app stays
keyless. Without it, Argos behaves exactly as before — it just can't explain a change.

**Status badges.** Each state differs in colour, icon, border and wording:
- **Verified · no change**: a fresh watcher record (≤ 5 min) matches the baseline, and any live read agrees. This means "no change seen as of block N", not "safe".
- **Change detected**: the watcher or a live read shows code that differs from the baseline. It means "check whether the descriptor still describes this code", never "malicious".
- **Not verified**: no record, an expired or stale record, an unsupported proxy, a failed live read, or a contract that isn't monitored. The reason is always shown.
- A contract that went A→B→A shows *"Matches baseline now, but a change was previously detected (block N)."*

**Privacy routing.** Live chain reads and descriptor downloads go through **Anon-RPC over the Nym mixnet by default**, so the RPC provider and the Swarm gateway see a Nym exit, not your IP. The worker boots on page load, while you're still reading the page, so the ~10–20 s tunnel setup is paid before you press anything; a boot that fails fast (the worker-bundle CDN download) retries automatically. In Nym mode a check **fails closed** — Not verified, with the reason — and never falls back to direct on its own. **Direct RPC** is a one-click, labelled opt-out for when you'd rather have speed than anonymity, and every result records which route it took. This path was not free: the worker never became ready for most of the event ([Test 4](docs/TEST_REPORT.md#test-4--anon-rpc-over-nym--fail-2026-11-06-0800-ist)), and only a retest at 11:37–11:43 IST showed it working — **60/60 reads, p95 2.4–3.6 s, 4/5 cold boots ready**, with the Swarm descriptor fetch going through the mixnet too and still passing its hash check ([retest](docs/test-runs/test4-nym-pass.txt)). Arkiv reads are the disclosed exception: always direct, keyless, bulk and contract-independent (see below).

**Descriptor storage.** Descriptor metadata (path, registry commit, raw-file keccak, ERC-8176 hash, attestation status, **Swarm reference**) comes from the Arkiv mirror written by the [importer](importer/src/import.ts). The descriptor itself is fetched **from Swarm** by the `swarm_ref` on its Arkiv row ([`importer/src/swarm.ts`](importer/src/swarm.ts) uploads the resolved JCS bytes), and `keccak256(bytes)` must equal the ERC-8176 hash on that row, or it is rejected. If Swarm can't be reached, the app falls back to the registry file at the pinned commit (checked against `file_sha`), and the provenance panel says so. A hash mismatch never falls back. A copy of the index ships with the app ([`web/public/registry-index.json`](web/public/registry-index.json)) and is used, with a visible label, only if Arkiv can't be reached. Details: [arkiv/swarm.md](arkiv/swarm.md).

## Monitored contracts

- Sepolia demo proxy `0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5` (OZ 5.6.1 transparent proxy; we
  upgrade it A→B→A in the demo).
- Sepolia guard demo proxy `0x3c93e603bbeD9Dc2Af817BC2D98Bc1D35CF1D669` (controlled demo of a
  check-and-call guard, see below).
- 30 mainnet registry proxies across 19 protocols: attested descriptors first, plus every beacon and
  diamond kind ([list](watcher/monitored-mainnet.json)).

## Check-and-call guard (controlled demo)

A status is "as of block N", so an upgrade can still land between a check and the transaction
(TOCTOU). On our own Sepolia proxy we show how that gap closes when a proxy can report its
implementation in a way the implementation can't fake:

- [`ArgosGuardableProxy`](contracts/src/ArgosGuardableProxy.sol): an OpenZeppelin transparent proxy
  whose own fixed code answers `argosImplementation()` from the EIP-1967 slot. Upgrades can't change
  the proxy's code, so the implementation can't misreport itself.
- [`ArgosGuard`](contracts/src/ArgosGuard.sol): `checkAndCall(proxy, expectedImplementation, data)`
  reverts with `ImplementationChanged(proxy, expected, actual)` unless the implementation matches,
  and otherwise forwards the call, in the same transaction.
- Sepolia: guardable proxy `0x3c93e603bbeD9Dc2Af817BC2D98Bc1D35CF1D669` (monitored by Argos), guard
  `0x32189Bb40fD8E565a870d6b513F1E32e6832E46a`
  ([deployment](contracts/deployments/11155111-guard.json)).
- `node --env-file=.env scripts/guard-demo.ts` reads the expected implementation from the **Argos
  baseline on Arkiv**, sends a guarded `increment()` (succeeds), upgrades the proxy to B, and sends it
  again (reverts, nothing runs) ([run log](docs/test-runs/guard-demo-sepolia.txt)). In the app,
  **Check → Guard demo proxy** simulates the guarded call with `eth_call`.

**Limits, plainly:** it only works for proxies that expose such a getter, and **no registry contract
does**. The target sees the guard as `msg.sender`, so it only suits calls that don't depend on the
sender. A real wallet would do the same check from the user's own account (e.g. a batched call from
a smart account). This is a demo of the mechanism, not protection for registry contracts.

## Arkiv

| Role | Address | Writes |
| --- | --- | --- |
| writer | `0x623EdFf351EB13aCCFc56cBf541eE4D45BDADCf4` | `dg_baseline`, `dg_descriptor`, `dg_deployment` |
| watcher | `0x8a883182b488cE04f08D348C64d9AC8EecACF2Bf` | `dg_current_state`, `dg_latest_change` |

Network: Arkiv **Rabdi** testnet (chain 7794095), `@arkiv-network/sdk@1.0.1`. Schema, owners and
expiry: [arkiv/schema.md](arkiv/schema.md). Mirror quality and re-run steps:
[arkiv/data-quality.md](arkiv/data-quality.md). Why Arkiv: [arkiv/why-arkiv.md](arkiv/why-arkiv.md).
Who uses it: [arkiv/reach.md](arkiv/reach.md). Feedback: [arkiv/friction.md](arkiv/friction.md).

What's on Arkiv now: **32 baselines** with live `current_state` / `latest_change` (30 mainnet
registry proxies + two Sepolia demo proxies), and the **ERC-7730 registry mirror**: 768
`dg_descriptor` + 2,675 `dg_deployment` rows at registry commit `ef582c2`, verified against
GitHub.

**Run a query** (read-only, no keys needed):

```bash
npm ci && node scripts/show-arkiv.ts
```

It prints every monitored contract's baseline, current state (or "NOT VERIFIED" if the watcher's
record has expired) and latest change, trusting only the two wallets above.

**Query the registry mirror** (read-only, no keys). This lists every registry descriptor whose
auditor attestation no longer matches its content (3 today):

```bash
npm ci && node scripts/query-mirror.ts stale
```

`node scripts/query-mirror.ts deployments 1 0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2` lists the
descriptors bound to one contract (here Aave v3 Pool on mainnet). Verify the whole mirror against
the registry yourself (counts + 10 random files against GitHub raw, no key):
`npm run verify -w importer -- ../.cache/registry` (clone steps in
[arkiv/data-quality.md](arkiv/data-quality.md#re-run-it)).

## Setup

Requirements: Node ≥ 22.10, Foundry, Git. Last verified end to end on Node 24.10.0 and
Foundry 1.7.1 (`forge test` 11/11).

```bash
git clone --recurse-submodules https://github.com/Monarchy712/Argos && cd Argos
npm ci
cp .env.example .env   # fill in keys locally; never commit .env
```

If you already cloned without `--recurse-submodules`, run `git submodule update --init --recursive`
before `forge test` — the contract tests need `forge-std` and `openzeppelin-contracts`.

| Command | What it does |
| --- | --- |
| `npm run dev` | companion web app on http://localhost:5180 |
| `npm test` | unit tests (core status / risky calldata / identity, watcher engine) |
| `npm run typecheck` | TypeScript check of everything |
| `npm start -w watcher` | run the watcher (Arkiv sink; needs `ARKIV_WATCHER_PRIVATE_KEY`, `ARKIV_ACCESS_KEY`, RPC URLs) |
| `npm run rebaseline -w watcher -- --chain <id> --address <0x..> --kind eip1967` | write or replace a baseline (writer key) |
| `npm run seed -w watcher` | baseline the selected mainnet proxies that have none (writer key) |
| `npm run renew -w watcher` | extend long-lived Arkiv rows expiring within 30 days |
| `npm run import -w importer -- ../.cache/registry [--dry]` | mirror the registry checkout into Arkiv (idempotent, resumable; writer key) |
| `npm run verify -w importer -- ../.cache/registry` | verify the mirror: counts + random spot-checks against GitHub (no key) |
| `npm run swarm -w importer -- ../.cache/registry [--public-gateway] [--restamp]` | put descriptor content on Swarm and record `swarm_ref` on Arkiv (writer key; `--dry` needs none) |
| `node scripts/query-mirror.ts stale|deployments <chain> <addr>|protocol <dir>` | read-only queries on the registry mirror (no key) |
| `bash scripts/test3.sh local\|sepolia` | Test 3: proxy-upgrade detection end to end |
| `node --env-file=.env scripts/test2.ts` | Test 2: Arkiv record lifecycle |
| `bash scripts/e2e-arkiv.sh` | watcher → Arkiv end to end on the Sepolia demo proxy |
| `bash scripts/demo-upgrade.sh A|B [guard]` | move a Sepolia demo proxy between ImplA and ImplB (deployer key) |
| `node --env-file=.env scripts/guard-demo.ts` | check-and-call guard demo on Sepolia (deployer key) |
| `cd contracts && forge test` | contract tests (demo proxy assumptions + guard) |

## Data and licenses

- Code: MIT, see [LICENSE](LICENSE).
- ERC-7730 descriptors: [CC0-1.0](https://github.com/ethereum/clear-signing-erc7730-registry/blob/master/LICENSE.md),
  from the EF registry at a pinned commit. Republishing is allowed. This is not Sourcify data.

## AI usage

Built with an AI coding assistant (Claude Code). Details per file: [AI_USAGE.md](AI_USAGE.md).

## CROPS

Submitted for **EF Best CROPS App**. Lead property: **Security**, i.e. *verify, don't trust*. Every
claim Argos shows can be checked independently, and when evidence is missing it fails closed
(**Not verified**) instead of showing a stale green.

- **S (security, the lead):** a descriptor renders only if `keccak256(bytes)` equals the ERC-8176 hash our writer published on Arkiv (tampered bytes are rejected, demo on the Check screen). Status comes from rows by two published `$creator` keys, which expire 10 minutes after a dead watcher's last write, and from the user's own live slot read, which must agree. The browser holds no keys; operator keys stay in a gitignored `.env`. Trust assumptions: our two keys, and RPC answers (cross-checked by the live read). Status is "as of block N" ([TOCTOU](docs/ARCHITECTURE.md#6-toctou-and-other-limitations-stated-plainly-in-the-readme)).
- **C (censorship resistance):** you depend on our watcher process and writer key, the Arkiv Rabdi testnet, a public Ethereum RPC, and the Swarm gateway. If the watcher stops or refuses you, contracts turn **Not verified** within 10 minutes (no false green) — censorship of us can't manufacture a false green, only an absence. Baselines, the mirror and descriptor content stay readable without us, keylessly. **The app itself is on Swarm** (`node scripts/publish-site.ts`; reference and limits in [arkiv/swarm.md](arkiv/swarm.md)), so the frontend survives our host disappearing — though the public gateways are default-deny for websites, so serving the HTML needs a Bee node or moderator approval. A forked watcher with its own keys can replace ours, but note the honest gap: the trusted writer addresses are compiled in (`packages/core/src/trust.ts`), so switching to a different operator means rebuilding, not a setting.
- **O (open source):** MIT ([LICENSE](LICENSE)); descriptors are CC0. Builds and runs from this repo alone: `npm ci && npm run dev`, no keys needed to use the app or run the read-only queries. Exact-pinned npm deps; Foundry deps as pinned submodules.
- **P (privacy):** no trackers or analytics. Live chain reads and descriptor downloads go through **Anon-RPC over the Nym mixnet by default**, so neither the RPC provider nor the Swarm gateway sees your IP or which contract you checked. The worker boots on page load (~10–20 s, before you press anything) and a check **fails closed** if it can't: Not verified, never a silent fallback. **Direct RPC is an explicit opt-out**, one click behind an explanation of what it costs, and every result stays labelled with the route it took. Arkiv reads are the one disclosed exception — always direct, but bulk and contract-independent, so Arkiv sees your IP and not the contract (table below).

### Details and trade-offs

- **Two hashes, two layers.** At import each ERC-8176 hash is computed twice (our JCS and the
  reference library) and compared with auditors' attestations in `sigs/`. That found **3 stale
  attestations** in the registry. At read time, the bytes from Swarm must match that hash; the
  registry fallback must match `file_sha`. A mismatch never falls back.
- **Separation of duties.** The watcher key can write state but never baselines (separate writer
  key). Unsupported proxies are never green, and a failed live read is never green.
- **Redacted logs.** The Arkiv SDK puts the access key in the URL path; every logged error passes
  through `describeError()`, which redacts it.
- **Trade-off: one watcher.** It's a single process with one key. Expiry makes its failure visible
  (Not verified), not invisible. Running two independent watchers and requiring agreement is a
  client change we haven't built.
- **Trade-off: direct Arkiv reads.** Arkiv's RPC didn't answer through the Nym exit in our spike,
  so the app reads Arkiv directly, in bulk, keyless, with identical queries for every visitor.
- **Trade-off: the anonymized default costs time.** Nym is the default for chain reads and
  descriptor downloads, which means a ~10–20 s tunnel setup and a slower first read (~15 s; after
  that ~0.8 s). We hide the setup by booting on page load and retry fast boot failures, but if the
  mixnet is unreachable a check fails closed rather than quietly going direct. Direct RPC stays one
  labelled click away. See the Test 4 retest in [docs/TEST_REPORT.md](docs/TEST_REPORT.md).
- **Trade-off: the app on Swarm isn't click-to-view.** The built app is published to Swarm
  (`node scripts/publish-site.ts`) so its bytes survive our host, but the public gateways are
  default-deny for websites: assets serve immediately, HTML needs moderator approval. Any Bee node
  serves the whole app. Details and the reference: [arkiv/swarm.md](arkiv/swarm.md).

### Demo moments (video)
1. A descriptor **fetched from Swarm** passes its hash check against Arkiv, and the intent renders (Check → Aave supply).
2. The same descriptor, tampered in the browser, is **rejected** (Check → "Demo: tamper…").
3. A live A→B upgrade of the Sepolia demo proxy turns the badge **RED** within one watcher cycle.
4. Stopping the watcher makes the status expire to **NOT VERIFIED** instead of a stale GREEN.

### What each third party can learn

Arkiv RPC node:

| Read | When | What it reveals to the Arkiv RPC node |
| --- | --- | --- |
| Baselines, current_state, latest_change (3 bulk queries) | page load, then every 90 s; and on each "Check" | IP address, and that Argos is open. Not which contract (every visitor sends identical queries). |
| Registry mirror (dg_descriptor + dg_deployment, ~36 paged bulk queries) | first "Check" in a session, then cached | IP address, and that the mirror was loaded. Not which contract. |
| Targeted mirror lookup | only if the keyless budget refuses the bulk read; **shown on screen when it happens** | IP address **and the contract being checked**. |
| Browse mirror | only when the user runs a filter | IP address and the filter (chain, protocol, …). |

Others:

| Third party | When | What it learns |
| --- | --- | --- |
| Ethereum RPC (PublicNode by default; set `VITE_MAINNET_RPC_URL` / `VITE_SEPOLIA_RPC_URL` to use your own) | each Check of a monitored contract (live slot read); token metadata for rendering | IP address and the contract being checked (direct mode). Through Nym (opt-in): neither. |
| Swarm gateway (`api.gateway.ethswarm.org`; set `VITE_SWARM_GATEWAY` for your own Bee node) | each Check with a descriptor | IP address and which descriptor (so roughly which dapp), in direct mode. Through Nym (opt-in): neither — verified in the Test 4 retest. |
| GitHub raw | only if Swarm is unreachable (shown on screen) | IP address and which descriptor file (direct mode). Through Nym (opt-in): neither. |
| Our server | none exists | nothing. The app is static files. |
| Analytics / trackers | none | nothing. |
