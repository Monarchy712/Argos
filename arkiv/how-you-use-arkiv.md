# Arkiv — how we use it

The two questions this criterion asks, answered directly:

1. **Do the things we filter on, who can edit each entity, and when it expires fit what the app
   does?**
2. **Does each Arkiv feature we use change something our users see?**

Source of truth for every claim below:
[`packages/core/src/arkivSchemas.ts`](../packages/core/src/arkivSchemas.ts) (schemas and expiry
policy), [`packages/core/src/trust.ts`](../packages/core/src/trust.ts) (the two trusted creators),
[`packages/core/src/status.ts`](../packages/core/src/status.ts) (how a badge is decided).

---

## 1. The eight entities, and why each is shaped the way it is

Argos's job is to let someone check whether the code behind an ERC-7730 clear-signing descriptor
has changed, **without trusting us**. Every schema choice below follows from that one sentence.

| Entity | Owner | Expiry | What it is for |
| --- | --- | --- | --- |
| `dg_baseline` | writer | `max()` ≈182 d, renewed | The trust anchor: the implementation a reviewer deliberately accepted. Never auto-replaced. |
| `dg_current_state` | watcher | `max()` ≈182 d, renewed | What the watcher last saw, with `checked_at`. Freshness, not expiry, decides the badge. |
| `dg_latest_change` | watcher | `max()` ≈182 d, renewed | The newest detected change, with its upgrade transaction. |
| `dg_change_note` | writer | `max()` ≈182 d, renewed | Facts about a 0G-generated explanation + `summary_hash`; the text itself is on Swarm. |
| `dg_watcher_health` | watcher | `max()` ≈182 d, renewed | The heartbeat: is anyone still watching, and how far has it scanned? |
| `dg_descriptor` | writer | `max()` ≈182 d, renewed | One row per registry descriptor file (771), with its ERC-8176 hash and `swarm_ref`. |
| `dg_deployment` | writer | `max()` ≈182 d, renewed | One row per (chain, address, descriptor) (2,678), with the proxy kind the registry omits. |
| `dg_recovery` | writer | `max()` ≈182 d, renewed | Provenance bridge when an expired entity is reconstructed from historical blocks. |

Full field lists, types and indexes: [`schema.md`](schema.md).

### Ownership: two keys, separated on purpose

Anyone can write an entity tagged `dg_*`, so **every read in Argos filters on `$creator`**
(`.createdBy(...)`) against two addresses that are compiled into the client:

| Role | Address | Writes |
| --- | --- | --- |
| writer | `0x623EdFf351EB13aCCFc56cBf541eE4D45BDADCf4` | `dg_baseline`, `dg_descriptor`, `dg_deployment`, `dg_change_note`, `dg_recovery` |
| watcher | `0x8a883182b488cE04f08D348C64d9AC8EecACF2Bf` | `dg_current_state`, `dg_latest_change`, `dg_watcher_health` |

This split is a security property, not bookkeeping. The watcher process runs unattended on a
server and holds **only** the watcher key, so a compromised watcher can report a false *current
state* — which the user's own live read then contradicts — but it **cannot move a baseline**,
because baselines are a different `$creator`. The watcher reads baselines by the writer's public
address. That is the whole reason the baseline is the trust anchor and the current state is not.

### Expiry: what it is for, and what it is explicitly *not* for

**This changed during the build, and the change is worth stating plainly, because the earlier
design is what most of our own documentation described.**

`dg_current_state` originally expired after **10 minutes**. A stopped watcher therefore showed up
as its rows *disappearing* from every query, and clients rendered **Not verified**. That worked.
It was also lossy, because it conflated four different things:

| | |
| --- | --- |
| entity expiry | how long a record survives to be read at all |
| watcher heartbeat | whether the process is running |
| last scanned block | how far through the chain it has got |
| monitoring freshness | whether what it last said is recent enough to rely on |

Expressing the third and fourth through the first meant throwing away **every observation older
than ten minutes** — which is exactly the history that disaster recovery and change auditing
need. So they are now separate concerns:

- **Expiry** is `ExpirationTime.max()` on every entity (the SDK caps a lifetime at `MAX_LIFETIME`
  = 7,884,000 blocks ≈ 182.5 days, and an extension resets the window), renewed on a sliding
  window by `npm run renew -w watcher` when under 30 days remain. Expiry's job is retention.
- **Freshness** is `checked_at` measured against `EXPIRY.freshnessSeconds` (**300 s**).
  `computeStatus` already measured this; it is now the only thing that decides a badge.
- **Liveness** is its own entity, `dg_watcher_health`, carrying `last_cycle_at`,
  `last_scanned_block`, `mode` and `failed_reads` per chain.

**The user-visible behaviour is unchanged: a stopped watcher still reads NOT VERIFIED, within 5
minutes instead of 10.** What changed is that the trail survives to be read afterwards, and the
reason is now stated ("no live watcher record") instead of inferred from an absence.

The one place expiry still carries user-visible weight is as a **dead-operator guarantee**: we
cannot renew rows after we stop paying attention, so the whole dataset is self-limiting rather
than stale-forever. That is a 182-day promise, not a 10-minute one, and we no longer claim
otherwise.

### Are the indexed fields the ones people actually filter on?

Every field below is `.indexed()` and is reached by a filter a user can trigger:

| Filter | Indexed field(s) | Where a user triggers it |
| --- | --- | --- |
| "contracts Argos monitors" | `chain_id`, `address` on `dg_baseline` | **My Contracts**, and the network switcher |
| "does this address have a descriptor?" | `chain_id` + `address` on `dg_deployment` | **Add Contract**, step 2 ("In the ERC-7730 registry") |
| "which descriptor, and where is its content?" | `descriptor_hash` on `dg_descriptor` | every descriptor fetch (gives `swarm_ref` + the hash to check) |
| "attestations that no longer match their content" | `attestation` on `dg_descriptor` | `node scripts/query-mirror.ts stale` → **3 rows** |
| "descriptors for this protocol" | `entity_dir` on `dg_descriptor` | `query-mirror.ts protocol <dir>` |
| "every mainnet beacon proxy" | `chain_id` + `proxy_kind` on `dg_deployment` | mirror filters |
| "anything that ever changed since its baseline" | `ever_changed_since_baseline` on `dg_current_state` | the A→B→A warning on a contract |
| "is it currently matching?" | `matches_baseline` on `dg_current_state` | the status badge |
| "is anyone still watching?" | `chain_id`, `last_cycle_at`, `mode` on `dg_watcher_health` | `scripts/show-arkiv.ts` header |
| "was this explanation generated, and by what?" | `zerog_request_id`, `model`, `same_surface` on `dg_change_note` | the **Investigate** tab's provenance footer |

Two deliberate non-indexes: `previous_value` / `new_value` on `dg_latest_change` (nobody searches
*for* an implementation address; they ask what a known contract changed to), and
`summary_swarm_ref` (always reached via its contract's row, never searched).

---

## 2. Does each Arkiv feature change something a user sees?

The track says plainly that the SDK installed but never read, or Arkiv used as a log nothing
reads, does not count. So, feature by feature:

| Arkiv feature | What it changes on screen |
| --- | --- |
| **`$creator` filtering** | A row written by any other wallet is not rendered at all. This is why the status badge means anything: it is "what these two published keys say", not "what some row on a public network says". Addresses are in the README and in `trust.ts`. |
| **Freshness via `checked_at`** | Stop the watcher and every contract reads **Not verified — no live watcher record** within 5 minutes, with the reason shown. It can never degrade to a stale green. |
| **`dg_watcher_health` heartbeat** | `scripts/show-arkiv.ts` prints liveness per chain before any contract: `mode`, `last_cycle_age_s`, `last_scanned_block`, `failed_reads`, and a `live` boolean. A reader does not have to infer a dead watcher from missing rows. |
| **Indexed queries** | The **Add Contract** flow answers "is this address in the ERC-7730 registry, and does its descriptor verify?" in one page load. `query-mirror.ts stale` returns the 3 broken attestations. On GitHub, both mean cloning and parsing 771 files. |
| **`executeBatch` atomicity** | A contract never renders half-updated: `current_state` and `latest_change` land in one transaction, so a change and the state that reflects it appear together. |
| **Expiry as retention + renewal** | Nothing survives us by more than ~182 days unless someone keeps renewing it, so the dataset cannot silently rot into permanent authority. |
| **Public, keyless reads** | The app ships no API key and no backend. Everything on screen is readable by anyone with `scripts/show-arkiv.ts`, which is how a user checks that the UI is not lying. |
| **Entity keys as citations** | Every claim in the **Evidence** tab links to the Arkiv entity key it came from, so the UI is checkable row by row rather than taken on trust. |

### What we deliberately kept *off* Arkiv

- **Descriptor content and the 0G explanation text.** An Arkiv `str` caps at 128 bytes. Both go to
  **Swarm**, with keccak256 of the bytes on the Arkiv row (`descriptor_hash`, `summary_hash`), so
  Arkiv stays the queryable index and Swarm the content store, and one hash check covers both.
- **A contract you added before a baseline exists.** It lives in your browser's own storage and is
  checked by your own `eth_call` reads. Writing it to Arkiv would need our writer key, and would
  publish which contracts you care about.
- **Anything per-user.** No accounts, no history, no preferences. There is nothing to publish,
  because Arkiv entities are public and a watchlist is a profile.
- **Verdicts.** No row says "safe" or "malicious". `dg_change_note` carries a description, its
  hash, the model and the 0G request id — never a judgement.

### The honest gap

The two trusted writer addresses are **compiled into the client**
([`trust.ts`](../packages/core/src/trust.ts)). Anyone can fork Argos, run their own watcher and
write the same public schemas — the data model fully supports a competing operator — but pointing
a client at a different one means rebuilding the app, not changing a setting. A trusted-writer
picker in the UI is the obvious fix and is not built.
