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
