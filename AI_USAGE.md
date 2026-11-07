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
| `packages/core/src/status.ts`, `risky.ts` + tests | generated | specified the GREEN / RED / NOT VERIFIED rules, the A→B→A line and the "never malicious" wording rule |
| `web/` (screens, chain reads, descriptor resolver, Arkiv read, styles) | generated; verified in the in-app browser | specified the screens, the resolver interface for Swarm, that a live read is labelled with the route it took, and badge requirements |
| `scripts/build-registry-index.ts`, `web/public/registry-index.json` | generated and run | — |
| `importer/` (registry reader, Arkiv import, verifier) | generated and run | specified idempotency, resumability, abort-on-hash-mismatch, and the verification (counts + 10 spot-checks vs GitHub) |
| `importer/src/swarm.ts`, `web/src/lib/descriptors.ts` (`SwarmFirstSource`), `arkiv/swarm.md` | generated and run; found that the public gateway accepts stampless uploads; verified Swarm read, tamper rejection and fallback in the in-app browser | set the Swarm plan (JCS bytes, one hash for Swarm + ERC-8176, never encrypted refs on Arkiv, registry fallback) |
| `scripts/query-mirror.ts` | generated and run | — |
| `scripts/publish-site.ts`, the Swarm site section of `arkiv/swarm.md` | generated and run; found by testing that the ethswarm gateways default-deny HTML until a moderator approves | asked for the built app on Swarm as a censorship-resistance deliverable; required the gateway limit be stated rather than worked around |
| `packages/core/src/selectors.ts` + tests, `scripts/explain-change.ts`, `dg_change_note`, `web/src/lib/changeNote.ts`, the Check change-note panel | generated and run against live 0G, Swarm and Arkiv; verified in the browser | rejected an AI "is it safe" verdict and specified a descriptive diff instead; chose bytecode selectors over verified source; required the request id, provider and cost be shown and the text hash-checked like a descriptor |
| `scripts/watcher-supervisor.sh` | generated; proven with `kill -9` | asked for the watcher to survive after it was lost twice |
| `contracts/src/ArgosGuardableProxy.sol`, `ArgosGuard.sol`, `test/ArgosGuard.t.sol`, `script/DeployGuardDemo.s.sol`, `scripts/guard-demo.ts`, the Check guard panel | generated, deployed to Sepolia and run; verified both paths in the browser | chose a separate proxy so the video demo stays untouched; required the "controlled demo" labelling and stated limits |
| `scripts/demo-upgrade.sh` | generated; switched from `forge script` to `cast send` after repeated RPC `block not found` errors | — |
| Rename DriftGuard → Argos (user-facing only) | applied | chose the name; ruled that `dg_*` schemas, env names and cursor files keep the working name |
| `arkiv/friction.md`, `reach.md`, `why-arkiv.md`, `data-quality.md` | drafted from test evidence and re-read registry issues | set what each must cover; review pending |
| `README.md`, `UPDATES.md`, `docs/TEST_REPORT.md`, `arkiv/*.md` | drafted | reviewed; final wording |
| `.env` (not committed) | generated wallet keys locally | funded wallets; added the Arkiv access key |
