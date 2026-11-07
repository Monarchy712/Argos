# Arkiv — reach

How many people depend on the ERC-7730 registry today, who would use Argos's copy on Arkiv
after Mumbai, and for what.

## Who depends on this data today (numbers, Nov 6 2026)

| Signal | Number | Source |
| --- | --- | --- |
| Descriptor files / deployments in the registry | **771 files, 2,678 deployments of 2,060 distinct contracts on 151 chains**, from **85 protocol folders** with **180 distinct owners** | our import at `ef582c2`; re-run with `npm run import -w importer -- ../.cache/registry --dry` |
| Registry contributors / commits | **95 contributors, 559 commits** since Feb 2024; 131 stars, **222 forks** (most are protocols opening PRs to add their descriptors) | GitHub API, `ethereum/clear-signing-erc7730-registry` |
| Wallet-side library that consumes it | `@ethereum-sourcify/clear-signing`: **4,310 npm downloads in the last 30 days** (2,475 in the last 7) | `api.npmjs.org/downloads/point/last-month/@ethereum-sourcify/clear-signing` |
| Standard | ERC-7730 (Draft), eight authors including Ledger engineers (`@lcastillo-ledger`, `@paoun-ledger`) and Sourcify (`@kuzdogan`) | [ERC-7730 header](https://eips.ethereum.org/EIPS/eip-7730) |
| Upgradeable share | **314 of 652 mainnet contracts (48%)** are proxies whose descriptor can silently go stale | our on-chain classification, [`watcher/monitored-mainnet.json`](../watcher/monitored-mainnet.json) |

So every wallet and signer that renders ERC-7730 descriptors depends on this data, and every
protocol that submitted a descriptor depends on it being shown correctly. Today none of them can
query it: it's files in a GitHub repo, with no implementation binding for proxies.

## The gap, in the registry's own words

The ERC-7730 registry team has two open issues about exactly this problem (re-read 2026-11-06):

- **[#3098 "`intentMutability` in spec"](https://github.com/ethereum/clear-signing-erc7730-registry/issues/3098)**
  (Milestone, Clear Signing PM board). It names upgradeable proxies as the first case where an
  intent the user signs can change after review: if the stored implementation changes, the
  behaviour can change completely. The preferred fix is detection on the signing device, which
  the issue notes hardware wallets may not support. The alternative it lists is **an external
  monitoring tool that regularly checks for such changes**. What to do on a change (revoke the
  attestation, a default blacklist, …) is "tbd".
- **[#2975 "Come up with a monitoring approach for proxies"](https://github.com/ethereum/clear-signing-erc7730-registry/issues/2975)**
  (on the Sourcify Public board, moved to sprint candidates). It proposes reacting to each
  `Upgraded` event of a proxy bound to an **EIP-712** descriptor, checking whether the domain
  changed.

Argos is a working version of #3098's "external monitoring tool" for the implementation
case. It doesn't decide the policy question; it publishes the evidence any policy needs (baseline,
current state, when it changed, which tx) as public, queryable, expiring Arkiv records. #2975's
EIP-712-domain check is our clearest next feature (see *Roadmap*).

How big is the gap? At registry commit `ef582c2`, **314 of 652 mainnet contracts with descriptors
(48%) are upgradeable proxies** (284 EIP-1967, 28 beacon, 2 diamond), and the registry records no
implementation binding for any of them.

## Who reads the data

| User | What they read from Arkiv | Why it's useful to them |
| --- | --- | --- |
| **Wallet teams integrating clear signing** (`@ethereum-sourcify/clear-signing` users) | `dg_current_state` + `dg_latest_change` by contract | Show "the code behind this descriptor changed at block N" next to the rendered intent, or fall back to raw calldata. No new backend: one query filtered on our watcher's `$creator`. |
| **The clear-signing working group / registry maintainers** | `dg_latest_change` across all contracts, `dg_descriptor.attestation` | Which reviewed descriptors now sit on changed code, i.e. which attestations should be re-reviewed. Our import already found **3 attestations in `sigs/` that sign different content than the current file** (`safe/calldata-SafeMigration-1.5.0`, `safe/eip712-Safe-Multisig`, `walletconnect/calldata-wct`). |
| **Auditors who attest descriptors (ERC-8176)** | `dg_descriptor` (descriptor_hash, attestation status) and `dg_latest_change` | An attestation covers a descriptor hash, not the code behind the proxy. Our data shows when a contract they reviewed has since been upgraded. |
| **Sourcify / Onay** (verification and descriptor tooling) | `dg_deployment.proxy_kind`, implementation history | A ready-made, queryable proxy classification of every registry deployment, plus upgrade history for re-verifying new implementations. |
| **Security dashboards and researchers** | everything, read-only | Public, keyless, no API key or ToS: query by chain, protocol, proxy kind or "ever changed". |

Reading needs no account and no key. Anyone can verify who wrote a row (`$creator`), and our
two writer addresses are published in the README.

## How it spreads

1. **The mirror is useful on day one, even without our watcher.** `dg_descriptor` /
   `dg_deployment` make the whole registry (771 files, 2,678 deployments) queryable by chain,
   address, protocol, kind, proxy kind and attestation status. GitHub can't do that. That alone
   is reason to point at the Arkiv data.
2. **Contribute upstream:** propose a link from #3098/#2975 to Argos's Arkiv schema as the
   reference data format for "external monitoring", and open a PR to the clear-signing library's
   docs showing a ~20-line "check Argos status" snippet for wallets.
3. **Others can run watchers.** The schema is public. A wallet team or auditor can run the watcher
   with their own key, and clients choose which `$creator`s they trust. Arkiv makes multiple
   independent monitors cheap to consume side by side.

## Can they try it today?

Yes, with no account, wallet or key:

- **App:** <https://argosapp.vercel.app>. Open **My Contracts** for the 33 watched contracts, or
  **Add Contract** with any registry address (e.g. Aave v3 Pool
  `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`) to see its mirror rows and Swarm-verified descriptor.
- **From a terminal:** `npm ci && node scripts/show-arkiv.ts` (watcher liveness + every verdict) or
  `node scripts/query-mirror.ts stale` (the 3 stale attestations).
- **From their own code:** one `createPublicClient` query filtered on our watcher's `$creator`
  (see [schema.md](schema.md#run-a-query)).

## Roadmap (after the event)

- EIP-712 domain drift (#2975): for proxies bound to `eip712-*` descriptors, compare
  `eip712Domain()` / `DOMAIN_SEPARATOR()` with the descriptor's domain on every `Upgraded` event.
- Extend monitoring from 30 to all 314 proxy deployments. The cost is RPC reads plus one batched
  Arkiv write per cycle.
- A wallet integration that shows the status inside the confirmation screen (a Snap or a hook in
  `@ethereum-sourcify/clear-signing`). Not built at Mumbai.
- Keep the Swarm copies pinned under our own postage batch and add new registry versions on
  each import, so the mirror carries content, not just hashes and pointers ([swarm.md](swarm.md)).
