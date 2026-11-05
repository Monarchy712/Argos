# Arkiv — reach

Who uses DriftGuard's data after Mumbai, and why it would live on Arkiv rather than in our
database.

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

DriftGuard is a working version of #3098's "external monitoring tool" for the implementation
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
   `dg_deployment` make the whole registry (768 files, 2,675 deployments) queryable by chain,
   address, protocol, kind, proxy kind and attestation status. GitHub can't do that. That alone
   is reason to point at the Arkiv data.
2. **Contribute upstream:** propose a link from #3098/#2975 to DriftGuard's Arkiv schema as the
   reference data format for "external monitoring", and open a PR to the clear-signing library's
   docs showing a ~20-line "check DriftGuard status" snippet for wallets.
3. **Others can run watchers.** The schema is public. A wallet team or auditor can run the watcher
   with their own key, and clients choose which `$creator`s they trust. Arkiv makes multiple
   independent monitors cheap to consume side by side.

## Roadmap (after the event)

- EIP-712 domain drift (#2975): for proxies bound to `eip712-*` descriptors, compare
  `eip712Domain()` / `DOMAIN_SEPARATOR()` with the descriptor's domain on every `Upgraded` event.
- Extend monitoring from 30 to all 314 proxy deployments. The cost is RPC reads plus one batched
  Arkiv write per cycle.
- A MetaMask Snap that shows the status inside the confirmation screen (stretch goal in our plan).
- Swarm-hosted descriptor content (pending Test 1), so the mirror carries content, not just
  hashes and pointers.
