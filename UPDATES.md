# Build log (for judges)

A dated, append-only log of what was built, what was verified, and what changed along the
way. Times are IST. Each entry points at the commits it covers.

## 2026-11-05 — Day 1

### ~21:50 · Repo scaffold
- Created the repo with `.gitignore` (secrets ignored before the first commit), MIT `LICENSE`,
  `.env.example` (placeholders only), and stubs for `README.md`, `AI_USAGE.md` and the
  `arkiv/` prize docs.
- Commit: `chore: scaffold repo with gitignore, MIT license and submission stubs`

### ~22:40 · Architecture blueprint (awaiting review)
- Wrote `docs/ARCHITECTURE.md`. Every external claim is marked VERIFIED (with source) or ASSUMED.
- Checked against the installed packages and official sources:
  - Arkiv SDK 1.0.1: Rabdi (chain 7794095) RPC/explorer, 32-attribute and 128 KiB caps,
    100-row pages, max lifetime of 7,884,000 blocks (about 182.5 days).
  - Anon-RPC harness is now **0.4.0** (the spike used 0.3.2). The Nym specifier is confirmed
    in the upstream `adopters.json5`.
  - ERC-8176 descriptor hash = keccak256 of the JCS form of the *resolved* descriptor.
    `@ethereum-sourcify/clear-signing` exports `computeDescriptorHash`.
  - Swarm uploads need a paid postage batch (bee-js 13.2.0).
- Design change from these findings: Swarm stores the JCS bytes of the resolved descriptor,
  so one hash proves both Swarm integrity and the ERC-8176 identity.
- Added the `arkiv/swarm.md` stub that the Arkiv + Swarm bonus requires.
- Problem hit: the GitHub REST API is rate-limited on the venue IP, so we read files
  through raw.githubusercontent.com instead.

## 2026-11-06 — Day 2

### Blueprint approved (v1)
- Approved with decisions D1–D3, plus a lower Arkiv write rate: slot reads every 60 s,
  `current_state` written every 120 s or immediately on change, batched where possible. Mainnet
  monitoring is capped at ~30 registry proxies (attested ones first), plus the Sepolia demo proxy.
- Generated the writer, watcher and Sepolia-deployer wallets locally. Keys are only in the
  gitignored `.env`, and the public addresses are in `docs/ARCHITECTURE.md` §11.
- Found that the PublicNode RPC rejects `eth_getLogs` without an address filter. The watcher
  always passes one.

### Test 3 (proxy detection): local PASS, Sepolia waiting on funds
- Demo contracts: `DemoImplA`/`DemoImplB` behind an OpenZeppelin v5.6.1
  `TransparentUpgradeableProxy`, with deploy/upgrade scripts (Foundry, pinned submodules).
- `packages/core`: EIP-1967 slots, the code-identity model, and an on-chain reader for
  EIP-1967, beacon, diamond, Safe and plain contracts.
- Watcher: a pure detection engine (sticky `ever_changed`), address-filtered event scans, an
  atomic cursor file, a file sink and the rebaseline CLI.
- `scripts/test3.sh local` passes all 10 checks. That includes a hard kill with an upgrade made
  while the watcher was down, plus slot-only detection with event scanning switched off. See
  `docs/TEST_REPORT.md`.
- Blocked: the Sepolia deployer and both Arkiv wallets need testnet funds. Faucets are a user
  action.
