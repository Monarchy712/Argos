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
registry ──► importer ──► Swarm: resolved descriptor bytes (746)  ◄── swarm_ref ── Arkiv: dg_descriptor (771) + dg_deployment (2,678)
chain ─────► watcher ───► Arkiv: dg_current_state + dg_latest_change + dg_watcher_health (heartbeat)
writer ────► rebaseline ► Arkiv: dg_baseline (the trust anchor; never auto-replaced)
change ────► 0G ────────► Swarm: what-changed text ◄── summary_hash ── Arkiv: dg_change_note
browser ───► reads Arkiv once (bulk) + its own live slot read (direct RPC) → GREEN / RED / NOT VERIFIED
```

- **Watcher:** scans `Upgraded` / `AdminChanged` / `BeaconUpgraded` / `DiamondCut` events from a
  persisted block cursor, and reads EIP-1967 / beacon / loupe / Safe slots every 60 s. A→B→A
  stays flagged (`ever_changed_since_baseline`). Each cycle also publishes a `dg_watcher_health`
  heartbeat per chain. If the watcher dies, its last reading goes stale after **5 minutes** and
  clients show **NOT VERIFIED** with the reason — never a stale green.
- **Liveness is `checked_at`, not expiry.** Entities are long-lived (~182 days, renewed), and a
  contract turns NOT VERIFIED when its newest reading is over 5 minutes old. An earlier build
  expressed this as a 10-minute entity expiry, so a dead watcher appeared as rows vanishing; that
  worked but destroyed the history. Same outcome, sooner, and the trail survives:
  [arkiv/schema.md](arkiv/schema.md#expiry-freshness-and-liveness--three-different-things).
- Full design, with every external claim marked VERIFIED or ASSUMED:
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Companion web app

```bash
npm ci && npm run dev    # http://localhost:5180
```

Four destinations, plus a workspace per contract.

**Why you'd open it again tomorrow.** You add the proxies you actually sign transactions to — your
DAO's treasury, the lending pool you deposit into — and accept a baseline once. From then on the
watcher checks them every 60 seconds and Argos tells you what you came for: nothing changed, or
something did. The notification bell carries the count of changed and not-verified contracts, so a
return visit is a two-second answer on a normal day and a readable account of what moved on the
day it matters. Nobody can usefully check 30 proxies by hand each morning, which is the whole
reason the app exists rather than a script.

| Destination | What it does |
| --- | --- |
| **Overview** | Your contracts at a glance: how many are verified, changed or not verified, and what the Argos watcher covers beyond them. |
| **My Contracts** | Two populations, never blended: **yours** (the contracts you added) and **the network** (what the Argos watcher monitors on Arkiv). Status badge, protocol, proxy kind, baseline vs current implementation, and the latest change. One bulk Arkiv read per trusted writer — identical for every visitor, so Arkiv can't tell which contract you care about. |
| **Add Contract** | A four-step guided flow for any proxy address. Argos probes its slots live (EIP-1967, beacon, loupe, clone, Safe), looks the address up in the **Arkiv registry mirror**, and fetches its ERC-7730 descriptor **from Swarm** and hash-checks it — then asks *you* to accept an implementation as the baseline. It never decides for you, and an unreadable pattern is reported as unsupported rather than as "not a proxy". |
| **How It Works** | The diagram, the trust assumptions and what Argos deliberately does not claim. |

Opening a contract gives five tabs:

| Tab | What it does |
| --- | --- |
| **Overview** | The status and why it says that, with the baseline it is measured against. |
| **Changes & History** | Every recorded change, with its block and upgrade transaction. |
| **Investigate Change** | Three kinds of claim, never blended: **observed** (what the watcher recorded on Arkiv), **derived** (a selector diff computed live from both implementations' deployed bytecode), and **described** (the 0G model's sentences, fetched from Swarm and rendered only if they hash to the value on Arkiv). |
| **Evidence** | Every claim with the record behind it: Arkiv entity keys, the Swarm reference, the ERC-8176 hash, the trusted writer addresses — plus **Verify now**, which re-fetches the descriptor from Swarm and re-hashes it in front of you, and a demo toggle that corrupts the bytes after download so you can watch the check reject them. |
| **Transaction Guard** | Simulates a guarded call through `ArgosGuard` with `eth_call` (controlled demo, see below). |

**What changed in the code (0G Private Computer).** Detecting a change leaves the reader with the
question Argos could never answer: *what* changed? **The watcher now answers it automatically.**
The moment it records an implementation move, [`watcher/src/explain.ts`](watcher/src/explain.ts)
recovers the 4-byte function selectors from the **deployed bytecode** of both implementations (no
block explorer, no verified source — it works on unverified contracts), diffs them, and asks a
model on **0G Private Computer** to describe the difference in two to four sentences. It runs
after the change is already on Arkiv, so nothing in the inference path can delay or block
detection. [`scripts/explain-change.ts`](scripts/explain-change.ts) remains for backfilling an
arbitrary pair of implementations.

**What breaks if 0G is removed:** a user who opens a changed contract sees two hex addresses and a
selector diff instead of a readable account of what moved — Argos goes back to saying only *that*
the code changed and leaving them to disassemble two contracts themselves. Detection survives;
the part of the product a non-expert can act on does not.

It is a description, **never a verdict**. The model is instructed not to say whether a change is
safe, unsafe, malicious or benign, and the panel repeats that. Argos does not decide whether an
upgrade is dangerous, and an AI confidence score would be the same unearned confidence this
project exists to warn about.

The text goes to **Swarm**; `dg_change_note` on Arkiv carries its keccak hash plus the facts —
which implementations, how many selectors moved, whether the call surface is unchanged, the
model, the **0G request id**, the provider and the cost. All of them are shown in the
**Investigate Change** tab, so any sentence can be traced to the run that produced it. The
browser renders the words only if they hash to the value on Arkiv, exactly as it treats a
descriptor, so a gateway cannot put different words in the model's mouth. Run log:
[`docs/test-runs/zerog-explain-change.txt`](docs/test-runs/zerog-explain-change.txt).

`ZEROG_API_KEY` is read only by the watcher and is never shipped to the browser, so the app stays
keyless.

**Status badges.** Each state differs in colour, icon, border and wording:
- **Verified · no change**: a fresh watcher record (≤ 5 min) matches the baseline, and any live read agrees. This means "no change seen as of block N", not "safe".
- **Change detected**: the watcher or a live read shows code that differs from the baseline. It means "check whether the descriptor still describes this code", never "malicious".
- **Not verified**: no record, an expired or stale record, an unsupported proxy, a failed live read, or a contract that isn't monitored. The reason is always shown.
- A contract that went A→B→A shows *"Matches baseline now, but a change was previously detected (block N)."*

**Privacy routing.** Argos ships no trackers, no analytics and no third-party assets: fonts and icons are served from this origin, so loading the page contacts nobody but the endpoints the app needs. Arkiv is read keyless as a single bulk, contract-independent query — identical for every visitor — so the Arkiv node sees an IP and never which contract you opened. Live chain reads and Swarm descriptor downloads go **direct from your browser** to a public RPC endpoint and the Swarm gateway, which do see your IP and which contract you are looking at. Every live result is labelled `direct RPC, not anonymized` so that is stated rather than left to assumption. An earlier build routed these reads over Anon-RPC/Nym; it was removed, and the reasoning is in [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

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
expiry: [arkiv/schema.md](arkiv/schema.md). How each Arkiv feature maps to something a user sees:
[arkiv/how-you-use-arkiv.md](arkiv/how-you-use-arkiv.md). Mirror quality and re-run steps:
[arkiv/data-quality.md](arkiv/data-quality.md). Why Arkiv: [arkiv/why-arkiv.md](arkiv/why-arkiv.md).
Who uses it: [arkiv/reach.md](arkiv/reach.md). Feedback: [arkiv/friction.md](arkiv/friction.md).

What's on Arkiv now: **33 baselines** with live `current_state` / `latest_change` (30 mainnet
registry proxies + Sepolia demo proxies), a `dg_watcher_health` heartbeat per chain, and the
**ERC-7730 registry mirror**: 771 `dg_descriptor` (620 calldata + 129 EIP-712 + 22 include) +
2,678 `dg_deployment` rows at registry commit `ef582c2`, verified against GitHub.

**Run a query** (read-only, no keys needed):

```bash
npm ci && node scripts/show-arkiv.ts
```

It prints the watcher's liveness per chain from `dg_watcher_health` — `mode`, how many seconds
since its last cycle, the last block it scanned, failed reads — and then every monitored
contract's baseline, current state and latest change with the verdict the browser would show
(`VERIFIED`, `CHANGE DETECTED`, or `NOT VERIFIED` with the reason), trusting only the two wallets
above.

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

- **C:** you depend on our watcher and writer key, Arkiv Rabdi, a public Ethereum RPC and the Swarm gateway. If the watcher stops or refuses you, every contract turns **Not verified** within 5 minutes with the reason — never a false green — while baselines, the mirror and descriptors stay readable keylessly, and the app itself is on Swarm.
- **O:** MIT ([LICENSE](LICENSE)), descriptors CC0. Builds and runs from this repo alone with `npm ci && npm run dev`, no keys.
- **P:** no trackers, analytics or third-party assets. Arkiv sees your IP but not which contract (one identical bulk query for everyone); the Ethereum RPC and Swarm gateway see your IP and the contract, and every live result says `direct RPC, not anonymized` ([table](#what-each-third-party-can-learn)).
- **S (lead):** a descriptor renders only if `keccak256(bytes)` equals the ERC-8176 hash published on Arkiv (tampered bytes are rejected on screen), and status needs fresh rows from two published `$creator` keys plus your own live slot read. The browser holds no keys; trust assumptions are our two keys and RPC answers.

### Details and trade-offs

- **Security, in full.** You can watch the hash check fail: the **Evidence** tab has a toggle that
  corrupts the bytes after download, and Argos renders nothing from them rather than trying another
  source. Status comes from rows by two published `$creator` keys, goes stale after 5 minutes, and
  must agree with the user's own live slot read. Operator keys stay in a gitignored `.env`. Status
  is "as of block N" ([TOCTOU](docs/ARCHITECTURE.md#6-toctou-and-other-limitations-stated-plainly-in-the-readme)).
- **Censorship resistance, in full.** Censorship of us can't manufacture a false green, only a
  visible absence, and `dg_watcher_health` records when we stopped. `node scripts/show-arkiv.ts`
  derives the same verdicts the UI shows without running the UI. The built app is published to
  Swarm (`node scripts/publish-site.ts`, reference in [arkiv/swarm.md](arkiv/swarm.md)), so the
  frontend survives our host disappearing. A forked watcher with its own keys can replace ours, but
  the trusted writer addresses are compiled in (`packages/core/src/trust.ts`), so switching operator
  means a rebuild, not a setting.
- **Open source, in full.** Exact-pinned npm deps; Foundry deps as pinned submodules.

- **Two hashes, two layers.** At import each ERC-8176 hash is computed twice (our JCS and the
  reference library) and compared with auditors' attestations in `sigs/`. That found **3 stale
  attestations** in the registry. At read time, the bytes from Swarm must match that hash; the
  registry fallback must match `file_sha`. A mismatch never falls back.
- **Separation of duties.** The watcher key can write state but never baselines (separate writer
  key). Unsupported proxies are never green, and a failed live read is never green.
- **Redacted logs.** The Arkiv SDK puts the access key in the URL path; every logged error passes
  through `describeError()`, which redacts it.
- **Trade-off: one watcher.** It's a single process with one key. Freshness makes its failure
  visible (Not verified within 5 minutes) rather than invisible, and `dg_watcher_health` records
  when it stopped. Running two independent watchers and requiring agreement is a client change we
  haven't built.
- **Trade-off: the app on Swarm isn't click-to-view.** The built app is published to Swarm
  (`node scripts/publish-site.ts`) so its bytes survive our host, but the public gateways are
  default-deny for websites: assets serve immediately, HTML needs moderator approval. Any Bee node
  serves the whole app. Details and the reference: [arkiv/swarm.md](arkiv/swarm.md).

### Demo moments (video)
1. A descriptor **fetched from Swarm** passes its hash check against Arkiv (**Evidence → Verify now**).
2. The same descriptor, corrupted after download, is **rejected** (**Evidence → "Demo: corrupt the bytes…"** → Verify now).
3. A live A→B upgrade of the Sepolia demo proxy turns the badge **RED** within one watcher cycle, and the watcher asks 0G what changed — shown in **Investigate Change** with its request id.
4. Stopping the watcher turns every contract **NOT VERIFIED** within 5 minutes instead of leaving a stale GREEN.

### What each third party can learn

Arkiv RPC node:

| Read | When | What it reveals to the Arkiv RPC node |
| --- | --- | --- |
| Baselines, current_state, latest_change, change notes, watcher health (bulk queries) | page load, then every 90 s | IP address, and that Argos is open. Not which contract (every visitor sends identical queries). |
| Registry mirror (dg_descriptor + dg_deployment, ~36 paged bulk queries) | first contract or Add Contract inspection in a session, then cached | IP address, and that the mirror was loaded. Not which contract. |
| Targeted mirror lookup | only if the keyless budget refuses the bulk read; **shown on screen when it happens** | IP address **and the contract being checked**. |

Others:

| Third party | When | What it learns |
| --- | --- | --- |
| Ethereum RPC (PublicNode by default; set `VITE_MAINNET_RPC_URL` / `VITE_SEPOLIA_RPC_URL` to use your own) | each Check of a monitored contract (live slot read); token metadata for rendering | IP address and the contract being checked. |
| Swarm gateway (`api.gateway.ethswarm.org`; set `VITE_SWARM_GATEWAY` for your own Bee node) | each Check with a descriptor | IP address and which descriptor (so roughly which dapp). |
| GitHub raw | only if Swarm is unreachable (shown on screen) | IP address and which descriptor file. |
| Our host (the hosted demo) | serving the page and its assets | your IP address and which files you fetched — the same as any web host. It does **not** see which contract you check: that is a direct browser-to-RPC call and a bulk, contract-independent Arkiv read. The app is static files; the host runs [`scripts/serve-static.ts`](scripts/serve-static.ts), which has no keys, reads no chain and stores nothing. Run it yourself with `npm run dev` and this row disappears entirely. |
| Analytics / trackers | none | nothing. |
