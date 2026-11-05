# AI usage

This project is built by one developer (Samyaak) working with an AI coding assistant
(**Claude Code**, Anthropic). This file lists what the AI generated or assisted with, and what the
human decided, reviewed or did by hand. It is kept up to date as the build goes on.

## How we worked

- **The human set the product, scope and architecture decisions**: the problem, prize targets,
  which components exist, trust model, status semantics (GREEN / RED / NOT VERIFIED), write cadence,
  the 30-contract monitoring cap, and approval of the blueprint and each design decision (D1–D3 in
  `docs/ARCHITECTURE.md`).
- **The AI wrote most of the code and docs**, checked APIs against the installed packages and
  official sources, ran the risk tests, and reported results and problems. Every external claim in
  the architecture doc is marked VERIFIED (with source) or ASSUMED.
- **The human did all wallet funding and account actions** (faucets, Arkiv access key, moving
  tGLM between wallets). Private keys were generated locally into a gitignored `.env` and never
  shown in chat or committed.
- Commits are small and frequent so the history shows how the build went. No code was copied
  from other repositories, including the author's own throwaway spike repo.

## Files

| File / area | AI role | Human role |
| --- | --- | --- |
| `docs/ARCHITECTURE.md` | drafted; verified APIs, versions and endpoints | defined requirements; approved v1 with changes (write cadence, cap, push policy) |
| `contracts/src/*`, `contracts/test/*`, `contracts/script/*` | generated | reviewed; chose OZ TransparentUpgradeableProxy for the demo |
| `packages/core/src/*` (slots, identity, reader, Arkiv schemas, trust) | generated | reviewed |
| `watcher/src/*` (engine, events, cursor, sinks, cycle, main, rebaseline, seed, renew) | generated | specified behaviour (sticky ever_changed, short-expiry liveness, cursor recovery) |
| `watcher/test/*`, `packages/core/test/*` | generated | — |
| `scripts/test2.ts`, `scripts/test3.sh`, `scripts/e2e-arkiv.sh` | generated and run | defined what each risk test must prove and the pass criteria |
| `scripts/select-mainnet-proxies.ts`, `watcher/monitored-mainnet.json` | generated and run | set the cap of ~30 with attested contracts first |
| `scripts/show-arkiv.ts`, `scripts/cleanup-test-rows.ts` | generated | — |
| `README.md`, `UPDATES.md`, `docs/TEST_REPORT.md`, `arkiv/*.md` | drafted | reviewed; final wording |
| `.env` (not committed) | generated wallet keys locally | funded wallets; added the Arkiv access key |
