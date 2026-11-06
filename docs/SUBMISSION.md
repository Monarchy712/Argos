# Argos — ETHGlobal Mumbai submission text

Copy each block into the matching field of the ETHGlobal form. Prize picks: **Arkiv** (Mirror
something Ethereum depends on, plus the Arkiv + Swarm bonus, which doesn't use a pick) and
**Ethereum Foundation** (Best CROPS App). No third pick.

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

- **mirrors the whole ERC-7730 registry to Arkiv**: 768 descriptor rows and 2,675 deployment rows,
  queryable by chain, address, protocol, kind, proxy kind and attestation status. The descriptor
  content is on **Swarm**, referenced from each Arkiv row and verified by its ERC-8176 hash;
- records each monitored contract's code identity at a **baseline**, and runs a **watcher** that
  detects upgrades (events plus slot reads) on 31 contracts (30 mainnet registry proxies and a
  Sepolia demo proxy). It publishes `current_state` and `latest_change` on Arkiv;
- shows, in a static web app, raw calldata → readable intent → a status:
  **Verified · no change**, **Change detected**, or **Not verified**.

Security is the point. A descriptor is rendered only if its bytes hash to the value our writer
published on Arkiv; tampered bytes are rejected. Status comes from two published Arkiv `$creator`
keys plus the user's own live read of the proxy slot. The watcher's records expire 10 minutes
after its last write, so a dead or censored watcher shows **Not verified**, never a stale green.
Importing the registry also surfaced **3 stale auditor attestations**, which sign different content
than the current files.

Argos detects, verifies and warns. It doesn't block transactions, doesn't guarantee safety, and
never calls an upgrade malicious.

## How it's made

TypeScript end to end, Node 24, npm workspaces, everything exact-pinned.

- **Arkiv** (`@arkiv-network/sdk@1.0.1`, Rabdi testnet): five typed schemas (`dg_*`). The
  **importer** reads the registry at a pinned commit, resolves `includes` with
  `@ethereum-sourcify/clear-signing`'s merge, computes each ERC-8176 hash twice (our RFC 8785 JCS +
  keccak, and the library's) and aborts on any mismatch. It compares the hashes with auditors'
  signed attestations and classifies every mainnet deployment on-chain (EIP-1967, beacon, diamond
  loupe, Safe). Writes are idempotent and resumable, in `executeBatch` transactions of 20 that halve on
  HTTP 413: 3,443 rows for 1.65 tGLM. A client-side verifier re-checks counts and 10 random files
  against GitHub raw.
- **Swarm** (`@ethersphere/bee-js@13.2.0` + the public gateway): we upload the *resolved* descriptor's
  JCS bytes, so one keccak hash proves both "Swarm returned the right bytes" and "this is the
  ERC-8176 descriptor auditors sign". Each upload is read back and checked before its reference is
  patched onto the Arkiv row. References are unencrypted; descriptors are public CC0 data.
- **Watcher**: scans `Upgraded` / `AdminChanged` / `BeaconUpgraded` / `DiamondCut` from a persisted
  cursor and reads the slots every 60 s (A→B→A stays flagged). It writes a contract's `current_state`
  and `latest_change` atomically in one batch: patch + extend, 10-minute expiry. The watcher key can't
  write baselines; a separate writer key does.
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
- **What didn't work:** Anon-RPC over Nym was meant to be the default for live reads. Its worker
  never became ready at the venue (two networks, three harness versions), so live reads are
  direct by default, labelled "not anonymized", and Nym is opt-in and fails closed.

---

## Partner: Arkiv — Mirror something Ethereum depends on (+ Arkiv + Swarm bonus)

**How we use it.** We mirror the EF's ERC-7730 clear-signing registry: 768 `dg_descriptor` +
2,675 `dg_deployment` rows at the registry's current `master` commit, plus per-contract
`dg_baseline`, `dg_current_state` and `dg_latest_change` from our watcher. Users read it in the app:
Check takes descriptor metadata and the Swarm reference from the mirror, Browse filters it with
Arkiv queries, and the status badge comes from the watcher's rows. Arkiv features map to what users
see. **Expiry** turns a dead watcher into "Not verified". **`$creator`** decides which rows are
trusted. **Indexed queries** power Browse and `scripts/query-mirror.ts`. **Public ownership** lets
anyone re-run the import or the verifier.
Writer `0x623EdFf351EB13aCCFc56cBf541eE4D45BDADCf4`, watcher `0x8a883182b488cE04f08D348C64d9AC8EecACF2Bf`.
One query: `node scripts/query-mirror.ts stale`.
Docs: `arkiv/schema.md`, `friction.md`, `reach.md`, `why-arkiv.md`, `data-quality.md`, `swarm.md`.

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

## Partner: Ethereum Foundation — Best CROPS App (lead property: Security)

**How it fits.** Argos exists for **security** in the "verify, don't trust" sense. Clear signing
is only as trustworthy as the binding between a descriptor and the code it describes, and for
proxies that binding silently breaks. Argos makes every claim checkable. Descriptor bytes must
match a hash published on Arkiv. Status comes from published keys plus the user's own live read.
A missing or dead watcher fails closed to "Not verified" through Arkiv expiry, which works structurally,
without us. The other three properties, with honest trade-offs:
**C:** static app, public data on Arkiv and Swarm; if our watcher stops or refuses you, you see Not verified, not a stale green.
**O:** MIT, builds and runs from the repo with no keys.
**P:** no trackers. Arkiv reads are bulk and contract-independent. Live chain reads are direct by default
(labelled), because Anon-RPC/Nym didn't boot at the event; Nym stays opt-in and fails closed.
The full CROPS section and a per-third-party privacy table are in the README.

**Feedback (EF / Anon-RPC).** The specifier lookup, the 18 MB bundle download and its hash check
all worked. The Nym worker then hung silently, with no log lines and no console errors, on venue
Wi-Fi and a phone hotspot, with harness 0.4.0, 0.3.3 and 0.3.2. A boot-progress log or a harness-level
boot timeout that reports the last phase reached would have turned an hour of guessing into a
bug report. Arkiv's RPC didn't answer through the Nym exit in our spike either, so mixed
anonymized/direct apps need endpoint support on both sides. Details: `docs/TEST_REPORT.md` (Test 4).

---

## Video timestamps (fill in after recording)

| Moment | Time |
| --- | --- |
| Problem (48%) | 0:00 |
| (a) Descriptor from Swarm, hash-checked against Arkiv | |
| (b) Tampered descriptor rejected | |
| (c) Live A→B upgrade → RED | |
| (d) Watcher stopped → NOT VERIFIED | |
