# Arkiv — why Arkiv

Argos publishes evidence that wallets and people rely on when deciding whether to trust a
rendered transaction. Four Arkiv properties carry that job, and each one shows up as something
the user sees.

## The short answer

**If this data sat in our Postgres, people could no longer:**
- trust a green badge after we stop: in a database our rows would keep saying "OK" forever. On
  Arkiv the record carries its own `checked_at` and a published heartbeat, so every client shows
  **Not verified** within 5 minutes, and nothing we own gets to decide otherwise (§1);
- check who wrote a row without trusting our server. On Arkiv, `$creator` is part of every
  entity, so clients filter on two published keys (§2);
- query it without asking us for an API key, or keep using it if we shut down (§3, §4);
- run their own watcher on the same public schema and point clients at it (§4).

**What people can do with our copy that they can't do with the registry on GitHub today:**
- **Filter it**: "every mainnet beacon-proxy deployment", "every stale attestation", "every
  descriptor bound to this address" are single Arkiv queries
  (`node scripts/query-mirror.ts stale`, or the **Browse mirror** screen). On GitHub you clone
  and parse 771 files.
- **See the proxy binding the registry doesn't record**: each deployment row carries its proxy kind,
  and each monitored contract has a baseline, current state and latest change.
- **Fetch the content without GitHub**: each `dg_descriptor` row points at the resolved descriptor
  on Swarm (`swarm_ref`) and carries the ERC-8176 hash that the bytes must match
  ([swarm.md](swarm.md)).

## 1. The record carries its own freshness → the "Not verified" badge

A healthy watcher rewrites `dg_current_state` every 120 s and publishes a `dg_watcher_health`
heartbeat per chain. A record older than **300 s** is stale, and every client shows
**NOT VERIFIED: no live watcher record**. If the watcher stops, crashes, loses its key or runs out
of gas, that is what a user sees within 5 minutes — never a green badge nobody is backing.

*(This mechanism changed during the build. `dg_current_state` originally expired after 10 minutes,
so a dead watcher appeared as rows vanishing. That worked but destroyed every observation older
than ten minutes. Records are now long-lived and freshness comes from `checked_at`, which
`computeStatus` already measured. Same user-visible outcome, sooner, and the history survives.
Full reasoning: [`schema.md`](schema.md#expiry-freshness-and-liveness--three-different-things).)*

- **What the user sees:** a contract never stays green on stale data. We tested it by killing the
  watcher and watching the Sepolia demo proxy flip to Not verified while its baseline and latest
  change stayed visible
  ([E2E report](../docs/TEST_REPORT.md#e2e--watcher-with-the-arkiv-sink-on-the-sepolia-demo-proxy--pass)).
- **Why not a database:** in Postgres, *we* would own the staleness rule. We could change it, log
  a different `checked_at`, or serve a cached green while the watcher was down, and no reader could
  tell. On Arkiv the inputs are public and signed by a published key: anyone can run
  `node scripts/show-arkiv.ts` and derive the badge themselves from `checked_at` and the
  heartbeat. The freshness rule stops being a promise from our server and becomes arithmetic a
  reader does on data we cannot retroactively edit.
- **The part that is still storage-enforced:** expiry. Every entity uses the maximum lifetime
  (~182 days) and is renewed by `npm run renew -w watcher`. We cannot renew rows after we stop
  paying attention, so the dataset ages out instead of standing as authority forever.

## 2. `$creator` is the trust anchor → "trusted writers" under the table

Anyone can write an entity tagged `dg_current_state`. Clients query with `.createdBy(<our
watcher>)` and `.createdBy(<our writer>)`, so forged rows are simply not returned. We tested it:
the same query with the wrong creator returns 0 rows (Test 2).

- **What the user sees:** the two trusted addresses are printed under the Monitored table and in
  the README, linked to the Arkiv explorer. You don't have to trust our server, because we don't
  have one. You trust two keys, and you can choose different ones.
- **Separation of duties:** the watcher key can write state but never baselines. Baselines are
  signed by a separate writer key, so a compromised watcher can't quietly move the reference
  point. `$creator` makes this verifiable by anyone, not just a policy in our code.
- **Many monitors:** a wallet team can run its own watcher (a fork with its own keys) and trust its own creator, or
  require agreement between two creators (a client change we haven't built). Reading both costs nothing extra on Arkiv.

## 3. Queryability → Monitored table, Browse mirror, one-query integrations

Every column a client filters on is indexed: `chain_id`, `address`, `matches_baseline`,
`ever_changed_since_baseline`, `proxy_kind`, `kind`, `entity_dir`, `attestation`,
`registry_commit`.

- **What the user sees:** the Monitored table is three bulk queries. **Browse mirror** filters
  3,449 registry rows by chain, protocol, kind and proxy kind with Arkiv queries, not a
  downloaded JSON. "Show me every attested descriptor on a contract that changed since baseline"
  is a query, not a crawler.
- **Why not GitHub:** the registry on GitHub is files in folders. You can't ask it "which Base
  deployments are beacon proxies" or "which attestations are stale" without cloning and parsing
  all of it.
- **Privacy by query shape:** the app reads all monitored rows in one contract-independent query
  per creator and filters locally, so the Arkiv node learns "someone opened Argos", not
  "someone is about to use Aave".

## 4. Public ownership → anyone can rebuild, check, or fork it

- The mirror is public and keyless to read. Anyone can recompute every row from the registry
  (`npm run import -w importer -- <checkout> --dry` shows the exact plan) and spot-check rows
  against GitHub (`npm run verify -w importer`). The data comes with its own audit trail
  (`registry_commit`, `file_sha`, `descriptor_hash`).
- **Anyone can run their own watcher** against the same public schema: fork, put your own two
  addresses in [`packages/core/src/trust.ts`](../packages/core/src/trust.ts), and run
  `npm run seed` / `npm start -w watcher` with your keys. A client then trusts your `$creator` instead
  of ours (comparing two watchers side by side is a small client change we haven't built).
- If we disappear, the data and schema remain, and someone else can start writing with their own
  key. That fits a public good the registry team explicitly wants
  ([#3098](https://github.com/ethereum/clear-signing-erc7730-registry/issues/3098)) better than a
  hosted API.

## What Arkiv doesn't do for us (stated honestly)

- **It doesn't make the watcher correct.** A live watcher can still be wrong (a bad RPC answer).
  The app adds the user's own independent live read of the implementation slot to cross-check (a direct RPC read, labelled as such).
- **It isn't private:** entities are public, and the browser's keyless read reveals its IP to the
  Arkiv node (it's the one direct call, disclosed in the README's CROPS section).
- **Keyless reads have a cost budget** ([friction](friction.md#2-keyless-reads-have-a-cost-budget-that-isnt-documented-with-numbers)),
  so clients must read in bulk and pace themselves.
