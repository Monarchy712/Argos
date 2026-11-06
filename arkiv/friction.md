# Arkiv — friction log

Everything that slowed us down while building DriftGuard on Arkiv, in the order we hit it, with
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

**Ask:** document the anonymous budget (units, window, typical query costs) and return the
`ratelimit` header on every response, so clients can pace themselves before hitting the wall.

## 3. The access key travels in the URL path, so errors leak it

`rabdi({ accessKey })` builds `https://rpc.rabdi…/ark_live_<key>`, and viem's error messages
include the full request URL. **Our first importer failure printed the key into a run log.** We
caught it before committing, deleted the log, and verified the key is in neither the tree nor the
git history. We now pass every logged error through `describeError()`, which redacts `ark_live_*`.

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

## 6. Anon-RPC / Nym (not Arkiv, but it shaped our Arkiv design)

- **Arkiv's RPC didn't answer through the Nym exit** in our spike (0/25), while Ethereum RPCs did. So
  we designed Arkiv reads as one bulk, contract-independent, keyless read. If Arkiv endpoints
  accepted mixnet exits, a privacy-focused app could read Arkiv anonymously too.
- **At the event, the Nym Anon-RPC worker never became ready at all** (Test 4). We timeboxed it to 45
  minutes; full detail is in [`docs/TEST_REPORT.md`](../docs/TEST_REPORT.md#test-4--anon-rpc-over-nym--fail-2026-11-06-0800-ist).
  - Same result on venue Wi-Fi and a phone hotspot, with `@anon-rpc/browser-harness` 0.4.0, 0.3.3
    and 0.3.2 (the version that booted in 10 s in our spike a day earlier).
  - Everything before the worker runs works: the specifier returns the expected `workerHash`, the
    18 MB bundle downloads in 0.3 s and matches it, the Nym API serves the topology (629 entry gateways),
    and sampled gateways accept TCP on 9000/9001/443.
  - The worker's outer layer only logs when `setupMixTunnel` throws, and we saw no log lines and no
    console errors. So the nested tunnel worker (a blob Worker inside the sandboxed iframe's worker)
    hangs silently. Chrome reported 5–10 s main-thread tasks while the worker was being set up.
  - **Consequence:** live reads default to direct RPC, labelled "not anonymized". Nym stays one click
    away and fails closed. We changed our EF target from Anon-RPC to CROPS.
  - **Ask (to the anon-rpc / Nym teams):** a boot-progress or heartbeat log from the worker (or a
    harness-level boot timeout that reports the last phase reached). A silent hang is the hardest
    failure to debug in a sandboxed, nested worker.

## What worked well

- The typed `defineSchema` API: wrong column types, missing required columns and filters on
  non-indexed columns are compile errors. It caught real mistakes for us.
- `executeBatch` with mixed creates, patches, deletes and extensions in one transaction gave
  atomic per-contract writes and atomic rebaselines (create the new baseline + delete the old one).
- Expiry as a first-class feature. Our "dead watcher → NOT VERIFIED" signal is just a 10-minute
  expiry, with no extra infrastructure.
- Fast reads: keyed p50 226 ms, and the 3,443-row mirror reads back in seconds.
