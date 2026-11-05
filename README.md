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
registry ──► importer ──► Swarm (descriptor JSON) + Arkiv (descriptor/deployment rows)   [build step 3]
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
expiry: [arkiv/schema.md](arkiv/schema.md).

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
| `npm test` | unit tests (core + watcher engine) |
| `npm run typecheck` | TypeScript check of everything |
| `npm start -w watcher` | run the watcher (Arkiv sink; needs `ARKIV_WATCHER_PRIVATE_KEY`, `ARKIV_ACCESS_KEY`, RPC URLs) |
| `npm run rebaseline -w watcher -- --chain <id> --address <0x..> --kind eip1967` | write or replace a baseline (writer key) |
| `npm run seed -w watcher` | baseline the selected mainnet proxies that have none (writer key) |
| `npm run renew -w watcher` | extend long-lived Arkiv rows expiring within 30 days |
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

- **C**ensorship resistance: TODO
- **O**pen source: MIT; everything builds from this repo plus pinned npm/Foundry dependencies.
- **P**rivacy: TODO (Anon-RPC/Nym for live reads; one bulk, contract-independent Arkiv read)
- **S**ecurity: TODO
