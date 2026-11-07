# Arkiv — friction log

Everything that slowed us down while building Argos on Arkiv, in the order we hit it, with
what we did about it. Evidence for each item is in [`docs/TEST_REPORT.md`](../docs/TEST_REPORT.md)
and the commit history. Overall the SDK was good to work with: its typed schemas caught most of
our mistakes at compile time. The items below are where docs, defaults or error messages cost us
time.

## 1. Docs and versions drifted from what the network runs

- **Our pre-event brief (from older docs and examples) said SDK 0.8.x on the Tiramisu testnet.**
  That stack can't write to the live network: 0.8.1 fails against Rabdi with
  `SystemAttributeNotWritable` on `$contentType`, and Tiramisu is superseded. We found this only by
  running a spike. The working stack is `@arkiv-network/sdk@1.0.1` + Rabdi (chain 7794095), with a
  different, typed-schema API, so any 0.8-shaped code needs a rewrite.
- `arkiv.network/docs` redirects through `docs.arkiv.network/start-here/fundamentals` (308 → 301 →
  "Redirecting to /start-here/introduction/"). Our fetch tooling gave up on the chain, so we
  read the facts we needed (RPC URLs, limits, lifetimes) from the installed package's
  `dist/*.d.ts` and source comments instead. Those comments are excellent (`MAX_LIFETIME`,
  `BLOCK_TIME`, "a patch never moves the expiry"), but they shouldn't be the primary place to
  find this.
- The SDK README's install snippet still shows `"@arkiv-network/sdk": "^0.9.0"` in the example
  `package.json`.

**Ask:** one "current network" page (chain ID, RPC/WS URLs, explorer, faucet, SDK version, limits,
max lifetime) that the README links to, plus a migration note for 0.8 → 1.0.

## 2. Keyless reads have a cost budget that isn't documented with numbers

Our first full Test 2 run passed all 9 functional checks, then **hung**. Probing showed HTTP 429:

```
ANON_COST_LIMITED · ratelimit: limit=10000, remaining=0, reset=217 · retry-after: 217
```

- The SDK warns "the public endpoint is heavily rate limited", but not the size or shape of the
  budget, or that it is cost-based (one query can cost far more than another).
- viem's default retries **hid the 429 as a hang**. We set `retryCount: 0` for keyless reads and
  surface the 429 ourselves.
- **Design impact:** our browser app holds no key (it's a public client), so keyless is the only
  option there. We made it do **one bulk read per page load** (three queries), refresh every
  90 s, and show a clear "Arkiv rate-limited" state that never turns a contract green.

- **Expected:** a 429 with a clear message, or documented numbers to stay under. **Happened:** the
  SDK client hung (viem retried silently), then 429 `ANON_COST_LIMITED`.
- **Reproduce:** `node scripts/show-arkiv.ts` in a loop with no `ARKIV_ACCESS_KEY` (about 3 bulk
  queries per run). After roughly a dozen runs in a minute the budget is spent; with viem's default
  `retryCount` the next call appears to hang for the `retry-after` period.

**Ask:** document the anonymous budget (units, window, typical query costs) and return the
`ratelimit` header on every response, so clients can pace themselves before hitting the wall.

## 3. The access key travels in the URL path, so errors leak it

`rabdi({ accessKey })` builds `https://rpc.rabdi…/ark_live_<key>`, and viem's error messages
include the full request URL. **Our first importer failure printed the key into a run log.** We
caught it before committing, deleted the log, and verified the key is in neither the tree nor the
git history. We now pass every logged error through `describeError()`, which redacts `ark_live_*`.

- **Expected:** errors without secrets. **Happened:** the access key in a log file.
- **Reproduce:** `createPublicClient({ chain: rabdi({ accessKey: "ark_live_test" }), transport: http() })`,
  stop your network, call any `select().fetch()`, and print `err.message`: the URL with the key is in it.

**Ask:** send the key in a header (`Authorization` / `X-Api-Key`), or have the SDK wrap transport
errors with the key redacted. Most teams will paste a stack trace into a GitHub issue sooner or
later.

## 4. Batch size is limited by HTTP payload, not by operation count

The spike wrote batches of 50 small entities. Our first real import batch (50 `dg_descriptor`
rows with 14 attributes each) failed with:

```
EntityMutationError: Transaction failed: Execution error without revert data
  cause: HTTP 413 (Payload Too Large) on eth_estimateGas
```

The top-level message ("execution error without revert data") pointed us at the contract, not the
transport. The importer now sends batches of 20 and halves automatically on a 413.

- **Expected:** "payload too large" or an automatic split. **Happened:** an execution-error
  message that pointed at the contract.
- **Reproduce:** `executeBatch({ creates })` with 50 entities of 14 attributes each (~120-byte
  strings); see `importer/src/import.ts` with `IMPORT_BATCH=50`.

**Ask:** document the request-size limit, and have `executeBatch` report a 413 as "batch too
large" (or split it automatically).

## 5. SDK behaviours we had to discover

- **`patchEntity` never changes expiry.** This is correct and documented in the type comments ("a
  patch never moves … the expiry"), but it's easy to miss. Our short-lived `current_state` rows
  need patch + `extendEntity` together. `executeBatch({ patches, extensions })` does both in one
  transaction, which is great once you know.
- **`key` is a reference type, not a 32-byte hash type.** We first planned to store hashes as
  `key`; the SDK docs it as "a reference to another entity", so we store hashes as `str`
  (66 bytes, under the 128-byte limit).
- **Patching an expired entity fails the whole batch.** When the watcher restarts after a long
  pause, its cached `current_state` keys may point at rows that expired. We re-read keys and retry
  once. A per-operation "skip if missing" option would make this simpler.
- **`$expiresAt` is a block number, not a timestamp.** It's obvious once you see
  `BLOCK_TIME = 2`, but the UI needs wall time, so we convert using the page's `blockNumber`.
- **Rows from other creators match named-schema queries.** This is correct, but it means
  `.createdBy()` is mandatory for anything security-relevant. We'd like that more prominent in the
  docs.
- **`process.exit()` after SDK calls trips a libuv assertion on Windows**
  (`!(handle->flags & UV_HANDLE_CLOSING)`), probably keep-alive sockets. We set `process.exitCode`
  and let the process exit on its own.

## 6. There is no way to say "one entity per key", and paging order hid the consequence

This one cost us a **wrong answer on screen**, which is worse than lost time, so it is the item
we would most like fixed.

**What we expected.** Our watcher keeps one `dg_current_state` per contract and patches it. We
assumed "one row per contract" was an invariant we controlled.

**What happened.** On 2026-11-06 two watcher processes ran at once for a few minutes (one
backgrounded, one started by hand). Each created its own `dg_current_state` row for the same
Sepolia contract, because a create cannot be made conditional on absence — there is no upsert, no
unique constraint, and no "create only if no entity matches this filter". We then compounded it:
we loaded our row keys with `.orderBy(asc("$key"))` and kept the last one seen per contract.
`$key` ordering is unrelated to write time, so we patched an arbitrary one of the pair forever and
left the other frozen. The frozen row still said `matches_baseline: true` for an implementation
that had since changed, and a reader taking either row got a different answer — one of them a
false green, which is the single failure mode this project exists to prevent.

**How to reproduce.** Write two entities of the same named schema with the same indexed
`chain_id` + `address` from the same wallet, then read them back with `.orderBy(asc("$key"))`.
Nothing in the API or the response indicates that two rows answer to the same logical identity.

**What we did.** `loadKeys` now takes the row with the newest payload timestamp (`checked_at` /
`detected_at`) rather than the last one paged, counts duplicates per schema, and reports the count
so the condition is visible instead of inferred ([`watcher/src/arkivSink.ts`](../watcher/src/arkivSink.ts)).
Readers independently take the newest observation, with a test for it.

**Asks, in order of how much they'd have helped:**
1. An optional **uniqueness constraint** on a set of indexed columns per schema, so a second
   create fails loudly instead of silently duplicating a logical row.
2. A **conditional create** (`createIfNotExists` with a filter), which is the operation every
   "one row per X" writer actually wants.
3. `orderBy` on **`$createdAt`** (or any server-side write-order field). We could only sort by a
   payload timestamp we happened to write ourselves; a reader without one has no way to pick.
4. A duplicate count, or any hint, in query results when several rows share the values a caller
   filtered on.

## 7. Anon-RPC / Nym (not Arkiv, but it shaped our Arkiv design)

- **Arkiv's RPC didn't answer through the Nym exit** in our spike (0/25), while Ethereum RPCs did. So
  we designed Arkiv reads as one bulk, contract-independent, keyless read. If Arkiv endpoints
  accepted mixnet exits, a privacy-focused app could read Arkiv anonymously too.
- **The Nym Anon-RPC worker never became ready for most of the event — then, on the same laptop and
  the same code, it suddenly did.** At ~08:00 it failed four times in a row (Test 4). At 11:37–11:43
  it booted 4 times out of 5 and served **60/60 reads** at p95 2.4–3.6 s, including a full
  Check in the app where both the chain read and the Swarm descriptor download went through the
  mixnet and the descriptor still passed its ERC-8176 hash check. Full detail:
  [`docs/TEST_REPORT.md`](../docs/TEST_REPORT.md) (the retest section, and the original FAIL below it).
  - **We never established what changed.** Nothing in Argos did. That is itself the friction: with no
    progress signal from the worker, "hung" and "slow" and "CDN blip" are indistinguishable, so we
    could neither debug the failure nor explain the recovery.
  - The failure mode we *could* name: one of the five retest boots died with `Failed to fetch` after
    ~5 s while pulling the ~18 MB worker bundle from the CDN. That one is legible, fails fast, and a
    retry fixed it.
  - **Cost shape, now that it works:** ~10–14 s cold boot, then ~15 s for the first request, then
    ~0.8 s per read. The one-off setup, not the per-read cost, is what makes it unsuitable as a
    default for a page a judge opens once.
  - Detail from the original failing run (still the only evidence about the hang itself):
    - Same result on venue Wi-Fi and a phone hotspot, with `@anon-rpc/browser-harness` 0.4.0, 0.3.3
      and 0.3.2 (the version that booted in 10 s in our spike a day earlier).
    - Everything before the worker runs worked: the specifier returned the expected `workerHash`, the
      18 MB bundle downloaded in 0.3 s and matched it, the Nym API served the topology (629 entry
      gateways), and sampled gateways accepted TCP on 9000/9001/443.
    - The worker's outer layer only logs when `setupMixTunnel` throws, and we saw no log lines and no
      console errors. So the nested tunnel worker (a blob Worker inside the sandboxed iframe's worker)
      hung silently. Chrome reported 5–10 s main-thread tasks while the worker was being set up.
    - Every *successful* boot in the retest logged `nym tunnel ready`. That line never appeared in any
      of the four failing attempts — so the hang is inside tunnel setup, before that point.
  - **Consequence:** live reads still default to direct RPC, labelled "not anonymized", because of the
    boot cost above, not because Nym is broken. Nym is one click away, fails closed, and is now
    verified end to end. Our EF target stays CROPS, which is what we built and documented.
  - **Ask (to the anon-rpc / Nym teams):** a boot-progress or heartbeat log from the worker (or a
    harness-level boot timeout that reports the last phase reached). A silent hang is the hardest
    failure to debug in a sandboxed, nested worker — and it is what kept us from explaining either
    the 08:00 failure or the 11:37 recovery. A second ask, smaller: make the bundle download a
    distinct, retryable error, since that one *is* legible and we hit it once in five boots.

## What worked well

- The typed `defineSchema` API: wrong column types, missing required columns and filters on
  non-indexed columns are compile errors. It caught real mistakes for us.
- `executeBatch` with mixed creates, patches, deletes and extensions in one transaction gave
  atomic per-contract writes and atomic rebaselines (create the new baseline + delete the old one).
- Expiry as a first-class feature. We first built "dead watcher → NOT VERIFIED" as a 10-minute
  expiry, with no extra infrastructure, and it worked on the first try. We later moved freshness
  onto `checked_at` and added a heartbeat entity, because expiry-as-liveness also deleted the
  history we wanted to keep — but having retention be a property of the data, rather than a cron
  job we maintain, is still the thing we'd miss most in Postgres.
- Fast reads: keyed p50 226 ms, and the ~3,450-row mirror reads back in seconds.
