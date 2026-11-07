# AI usage

Argos is designed and built by one developer (Samyaak). I used an AI coding assistant
(**Claude Code**, Anthropic) to speed up implementation. This file lists, per area, what I decided
and what Claude Code helped with. It is kept up to date as the build goes on.

## How I worked

- **I made the product, scope and architecture decisions**: the problem and how to measure it,
  the prize targets, which components exist, the trust model (separate writer and watcher keys,
  two published `$creator` wallets), the status semantics (Verified / Change detected / Not
  verified) and the fail-closed rule, the write cadence, the 30-contract monitoring cap, mirroring
  the ERC-7730 registry on Arkiv with content on Swarm, the hash rule that ties the two together,
  the three-layer disaster recovery, and every design decision in `docs/ARCHITECTURE.md` (D1–D3).
- **Claude Code helped implement those decisions**: it wrote code and drafted docs to my
  specifications, checked APIs against the installed packages and official sources, and ran the
  tests I defined. I reviewed its output, directed changes when something was wrong, and tested
  each part against live networks and in the browser before keeping it.
- **I did all wallet and account actions myself** (faucets, the Arkiv access key, moving tGLM
  between wallets, the 0G key). Private keys were generated locally into a gitignored `.env` and
  never shown in chat or committed.
- Commits are small and frequent so the history shows how the build went. No code was copied
  from other repositories, including my own throwaway spike repo.

## Files

| File / area | What I decided | Claude Code's help |
| --- | --- | --- |
| `docs/ARCHITECTURE.md` | defined the requirements; approved v1 with changes (write cadence, cap, push policy) | drafted the document; verified APIs, versions and endpoints |
| `contracts/src/*`, `contracts/test/*`, `contracts/script/*` | chose the OZ TransparentUpgradeableProxy for the demo; reviewed | implementation |
| `packages/core/src/*` (slots, identity, reader, Arkiv schemas, trust) | the schema design and trust model; reviewed | implementation |
| `watcher/src/*` (engine, events, cursor, sinks, cycle, main, rebaseline, seed, renew) | specified the behaviour (sticky ever_changed, freshness-based liveness, cursor recovery and replay) | implementation |
| `watcher/src/recover.ts`, `dg_recovery` | specified the recovery model: rebuild expired entities from Arkiv chain history, never mark them verified until read back, and record old key → new key on Arkiv | implementation; decoding against the SDK's own ABI shapes |
| `watcher/test/*`, `packages/core/test/*` | reviewed | drafted the tests |
| `scripts/test2.ts`, `scripts/test3.sh`, `scripts/e2e-arkiv.sh` | defined what each risk test must prove and the pass criteria | implementation; ran them |
| `scripts/select-mainnet-proxies.ts`, `watcher/monitored-mainnet.json` | set the cap of ~30 with attested contracts first | implementation; ran it |
| `scripts/show-arkiv.ts`, `scripts/cleanup-test-rows.ts` | reviewed | implementation |
| `packages/core/src/status.ts`, `risky.ts` + tests | specified the Verified / Change detected / Not verified rules, the A→B→A line and the "never malicious" wording rule | implementation |
| `web/` (screens, chain reads, descriptor resolver, Arkiv read, styles) | specified the screens, the resolver interface for Swarm, route labelling for live reads, and the badge requirements | implementation; checked it in the in-app browser |
| `scripts/build-registry-index.ts`, `web/public/registry-index.json` | reviewed | implementation; ran it |
| `importer/` (registry reader, Arkiv import, verifier) | specified idempotency, resumability, abort-on-hash-mismatch, and the verification (counts + 10 spot-checks against GitHub) | implementation; ran it |
| `importer/src/swarm.ts`, `web/src/lib/descriptors.ts` (`SwarmFirstSource`), `arkiv/swarm.md` | set the Swarm plan (JCS bytes, one hash for Swarm and ERC-8176, never encrypted refs on Arkiv, registry fallback) | implementation; found that the public gateway accepts stampless uploads; checked the Swarm read, tamper rejection and fallback in the browser |
| `scripts/query-mirror.ts` | reviewed | implementation; ran it |
| `scripts/publish-site.ts`, the Swarm site section of `arkiv/swarm.md` | asked for the built app on Swarm as a censorship-resistance deliverable; required the gateway limit be stated rather than worked around | implementation; found by testing that the ethswarm gateways default-deny HTML until a moderator approves |
| `packages/core/src/selectors.ts` + tests, `watcher/src/explain.ts`, `scripts/explain-change.ts`, `dg_change_note`, `web/src/lib/changeNote.ts`, the change-note panel | rejected an AI "is it safe" verdict and specified a descriptive diff instead; chose bytecode selectors over verified source; required the request id, provider and cost be shown and the text hash-checked like a descriptor | implementation; ran it against live 0G, Swarm and Arkiv |
| `scripts/watcher-supervisor.sh` | required the watcher to restart itself after it was lost twice | implementation; tested with `kill -9` |
| `contracts/src/ArgosGuardableProxy.sol`, `ArgosGuard.sol`, `test/ArgosGuard.t.sol`, `script/DeployGuardDemo.s.sol`, `scripts/guard-demo.ts`, the guard panel | designed the check-and-call demo; chose a separate proxy so the video demo stays untouched; required the "controlled demo" labelling and stated limits | implementation; deployed to Sepolia and ran both paths |
| `scripts/demo-upgrade.sh` | reviewed | implementation; switched from `forge script` to `cast send` after repeated RPC `block not found` errors |
| Rename DriftGuard → Argos (user-facing only) | chose the name; ruled that `dg_*` schemas, env names and cursor files keep the working name | applied the rename |
| `arkiv/friction.md`, `reach.md`, `why-arkiv.md`, `data-quality.md` | set what each must cover; reviewed | drafted from test evidence and the registry issues |
| `README.md`, `UPDATES.md`, `docs/TEST_REPORT.md`, `arkiv/*.md` | reviewed; final wording | drafted |
| `.env` (not committed) | funded the wallets; added the Arkiv and 0G keys | generated wallet keys locally |
