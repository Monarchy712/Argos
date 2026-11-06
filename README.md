# DriftGuard (working name)

Contract-change detection and verification for ERC-7730 clear-signing descriptors.
DriftGuard **detects, verifies and warns**. It does not block transactions, does not guarantee
safety, and never calls an upgrade malicious.

> Status: hackathon build in progress (ETHGlobal Mumbai, from-scratch track). Progress log:
> [UPDATES.md](UPDATES.md) · risk tests: [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

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

DriftGuard records each monitored contract's code identity at a **baseline** and publishes, on
[Arkiv](https://arkiv.network), whether it still matches, whether it ever changed, and the latest
change with its transaction.

## How it works

```
registry ──► importer ──► Arkiv: dg_descriptor (768) + dg_deployment (2,675)   [Swarm content after Test 1]
chain ─────► watcher ───► Arkiv: dg_current_state (10-min expiry), dg_latest_change
writer ────► rebaseline ► Arkiv: dg_baseline (the trust anchor; never auto-replaced)
browser ───► reads Arkiv once (bulk) + live slot reads over Anon-RPC/Nym → GREEN / RED / NOT VERIFIED
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
| **Check a transaction** | Paste `{chainId, to, data}` or a raw transaction. Shows the raw calldata and the readable ERC-7730 intent. The descriptor's path, commit and hashes come from the **Arkiv registry mirror**, and the file is fetched and checked against them before `@ethereum-sourcify/clear-signing` renders it. Also shows risky-calldata flags (upgrades, `changeMasterCopy`, Safe `operation=1`) and a status from the watcher's Arkiv record plus a live code-identity read. |
| **Browse mirror** | Filter the mirrored registry by chain, protocol, descriptor kind, proxy kind and "monitored". Each filter is an Arkiv query, and the queries run are shown on screen. |
| **Nym diagnostics** | Boots the Anon-RPC Nym worker and runs Test 4: 20 slot reads with boot time, success count, HTTP statuses, p50/p95. |

**Status badges.** Each state differs in colour, icon, border and wording:
- **Verified · no change**: a fresh watcher record (≤ 5 min) matches the baseline, and any live read agrees. This means "no change seen as of block N", not "safe".
- **Change detected**: the watcher or a live read shows code that differs from the baseline. It means "check whether the descriptor still describes this code", never "malicious".
- **Not verified**: no record, an expired or stale record, an unsupported proxy, a failed live read, or a contract that isn't monitored. The reason is always shown.
- A contract that went A→B→A shows *"Matches baseline now, but a change was previously detected (block N)."*

**Privacy routing.** Live chain reads and descriptor fetches go through Anon-RPC (Nym) by default. If Nym can't boot or a request times out, the check **fails and shows Not verified**; there is no silent fallback to direct RPC. The viewer can switch to direct RPC explicitly (labelled "not anonymized", never saved). Disclosed exclusions: the one bulk Arkiv read (Arkiv's RPC didn't answer through the Nym exit in our spike) and the harness's one bootstrap read of the Nym specifier contract.

**Descriptor storage.** Descriptor metadata (path, registry commit, raw-file keccak, ERC-8176 hash, attestation status) comes from the Arkiv mirror written by the [importer](importer/src/import.ts). The file itself is fetched from the registry at that commit and must match the hash from Arkiv. A copy of the index ships with the app ([`web/public/registry-index.json`](web/public/registry-index.json)) and is used, with a visible label, only if Arkiv can't be reached. After Swarm is set up (Test 1), a Swarm source plugs in behind the same `DescriptorSource` interface without UI changes.

## Monitored contracts

- Sepolia demo proxy `0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5` (OZ 5.6.1 transparent proxy; we
  upgrade it A→B→A in the demo).
- 30 mainnet registry proxies across 19 protocols: attested descriptors first, plus every beacon and
  diamond kind ([list](watcher/monitored-mainnet.json)).

## Arkiv

| Role | Address | Writes |
| --- | --- | --- |
| writer | `0x623EdFf351EB13aCCFc56cBf541eE4D45BDADCf4` | `dg_baseline`, `dg_descriptor`, `dg_deployment` |
| watcher | `0x8a883182b488cE04f08D348C64d9AC8EecACF2Bf` | `dg_current_state`, `dg_latest_change` |

Network: Arkiv **Rabdi** testnet (chain 7794095), `@arkiv-network/sdk@1.0.1`. Schema, owners and
expiry: [arkiv/schema.md](arkiv/schema.md). Mirror quality and re-run steps:
[arkiv/data-quality.md](arkiv/data-quality.md). Why Arkiv: [arkiv/why-arkiv.md](arkiv/why-arkiv.md).
Who uses it: [arkiv/reach.md](arkiv/reach.md). Feedback: [arkiv/friction.md](arkiv/friction.md).

What's on Arkiv now: **31 baselines** with live `current_state` / `latest_change` (30 mainnet
registry proxies + the Sepolia demo proxy), and the **ERC-7730 registry mirror**: 768
`dg_descriptor` + 2,675 `dg_deployment` rows at registry commit `ef582c2`, verified against
GitHub.

**Run a query** (read-only, no keys needed):

```bash
npm ci && node scripts/show-arkiv.ts
```

It prints every monitored contract's baseline, current state (or "NOT VERIFIED" if the watcher's
record has expired) and latest change, trusting only the two wallets above.

## Setup

Requirements: Node ≥ 22.10 (tested on 24.12), Foundry 1.5.x, Git.

```bash
git clone --recurse-submodules https://github.com/Monarchy712/Argos && cd Argos
npm ci
cp .env.example .env   # fill in keys locally; never commit .env
```

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
| `bash scripts/test3.sh local\|sepolia` | Test 3: proxy-upgrade detection end to end |
| `node --env-file=.env scripts/test2.ts` | Test 2: Arkiv record lifecycle |
| `bash scripts/e2e-arkiv.sh` | watcher → Arkiv end to end on the Sepolia demo proxy |

## Data and licenses

- Code: MIT, see [LICENSE](LICENSE).
- ERC-7730 descriptors: [CC0-1.0](https://github.com/ethereum/clear-signing-erc7730-registry/blob/master/LICENSE.md),
  from the EF registry at a pinned commit. Republishing is allowed. This is not Sourcify data.

## AI usage

Built with an AI coding assistant (Claude Code). Details per file: [AI_USAGE.md](AI_USAGE.md).

## CROPS

DriftGuard's lead property is **Privacy** for the user checking a transaction, together with
fail-closed **Security**. The other two properties hold, with the trade-offs below.

- **C (censorship resistance):** What users depend on: our **watcher** (one process, one key) and our
  **writer key** (baselines + registry mirror). If the watcher stops or is censored, its
  `current_state` rows expire within 10 minutes and every client shows **Not verified**. It fails
  closed and never leaves a stale green. Baselines and the mirror stay readable for ~182 days. All data
  lives on Arkiv, not on our server. The web app is static (any host or IPFS works), and anyone can run their own
  watcher with their own key and have clients trust that `$creator` instead of, or as well as, ours.
  Remaining dependencies: the Arkiv Rabdi testnet and public Ethereum RPCs.
- **O (open source):** MIT. Builds and runs from this repo alone (`npm ci`, exact-pinned npm deps, Foundry
  deps as pinned git submodules). ERC-7730 data is CC0. No closed services; `.env` holds only the
  operator's own keys and RPC URLs.
- **P (privacy):** Live chain reads and descriptor downloads go through **Anon-RPC over Nym by default**,
  so the RPC provider and GitHub see a Nym exit, not the user's IP. If Nym fails, the check fails
  (Not verified). It never silently falls back to direct RPC, and direct mode is an explicit,
  labelled, unsaved switch. Disclosed exclusions: (1) **Arkiv reads are direct and keyless**:
  the Arkiv node sees the user's IP and that DriftGuard was opened, but reads are bulk and
  contract-independent, so it doesn't learn which contract (details below). (2) The Anon-RPC
  harness reads the Nym specifier contract once through a public RPC (reveals only "loads the Nym
  worker"). (3) The static host sees the page load. No trackers or analytics. *Nym path: pending
  Test 4.*
- **S (security):** The browser holds no keys. The watcher key can write state but never baselines,
  which come from a separate writer key. Clients trust rows only by `$creator`. Every descriptor
  file is checked byte-for-byte (keccak256) against the mirror before rendering, and the ERC-8176 hash
  is recomputed two ways at import. The Anon-RPC client bundle is hash-pinned by the harness. Trust
  assumptions: our two keys are honest; the watcher's RPC is honest (cross-checked by the user's
  live read); a status is "as of block N" (an upgrade can land between check and execution, see
  [TOCTOU](docs/ARCHITECTURE.md#6-toctou-and-other-limitations-stated-plainly-in-the-readme)).
  Operator keys live only in a gitignored `.env`, and logged errors are redacted.

### What the Arkiv node can learn

| Read | When | What it reveals to the Arkiv RPC node |
| --- | --- | --- |
| Baselines, current_state, latest_change (3 bulk queries) | page load, then every 90 s; and on each "Check" | IP address, and that DriftGuard is open. Not which contract (every visitor sends identical queries). |
| Registry mirror (dg_descriptor + dg_deployment, ~36 paged bulk queries) | first "Check" in a session, then cached | IP address, and that the mirror was loaded. Not which contract. |
| Targeted mirror lookup | only if the keyless budget refuses the bulk read; **shown on screen when it happens** | IP address **and the contract being checked**. |
| Browse mirror | only when the user runs a filter | IP address and the filter (chain, protocol, …). |
