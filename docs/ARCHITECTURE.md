# DriftGuard — Architecture blueprint

> Status: **v1, approved** (2026-11-06) with D1–D3 as recommended plus the write-rate and
> monitoring-cap changes in §2.4 and §4.2. Every external claim is tagged
> **VERIFIED** (with source) or **ASSUMED** (to be checked by a named risk test).
> DriftGuard **detects, verifies and warns**. It does not block transactions, does not
> guarantee safety, and never calls an upgrade malicious.

## 0. The problem in one paragraph

ERC-7730 descriptors are keyed by `(chainId, address)`. For an upgradeable proxy that address
is the proxy, so after an upgrade the wallet still finds "the" descriptor and still renders a
confident, human-readable intent, while different code runs. The registry contains **no**
proxy or implementation binding (spike S3: 0 of 743 descriptors declare one). Registry issue
[#3098](https://github.com/ethereum/clear-signing-erc7730-registry/issues/3098) names upgradeable
proxies as a case where a signed intent can change, and lists "an external monitoring tool that
regularly checks for such changes" as the alternative to on-device detection (response still
"tbd"). [#2975](https://github.com/ethereum/clear-signing-erc7730-registry/issues/2975) proposes
checking proxies bound to EIP-712 descriptors for domain changes on each `Upgraded` event
(VERIFIED, re-read 2026-11-06; earlier wording "maintainers asked for an external monitor"
overstated #2975). DriftGuard is such a monitor for the implementation case: it records each
monitored contract's baseline code identity and publishes what changed and when. EIP-712
domain checks are future work.

## 1. Components

```mermaid
flowchart LR
  subgraph Sources
    REG[ERC-7730 registry<br/>GitHub, CC0, pinned commit]
    CHAIN[(Ethereum mainnet / Sepolia)]
  end

  subgraph Offchain jobs [Node.js jobs, ordinary RPC]
    IMP[importer<br/>writer wallet]
    WAT[watcher<br/>watcher wallet<br/>block cursor on disk]
    RB[rebaseline CLI<br/>writer wallet]
  end

  subgraph Storage
    SW[(Swarm<br/>canonical descriptor JSON)]
    ARK[(Arkiv Rabdi<br/>typed entities)]
  end

  subgraph Browser [Companion web app: React + Vite]
    UI[browse / paste tx / status badge]
    CS[@ethereum-sourcify/clear-signing<br/>custom resolver]
    AW[AnonRpcWorker<br/>Nym, sandboxed iframe]
  end

  REG --> IMP
  IMP -->|upload JCS bytes| SW
  IMP -->|descriptor + deployment entities| ARK
  CHAIN -->|events + slot reads| WAT
  WAT -->|current_state / latest_change| ARK
  RB -->|baseline| ARK

  UI -->|1 bulk keyless query, direct| ARK
  UI --> CS
  CS -->|descriptor by Swarm ref| AW
  UI -->|live eth_getStorageAt / eth_getCode / eth_call| AW
  AW -->|Nym mixnet| CHAIN
  AW -->|Nym mixnet| SW
```

| Component | Dir | Runtime | Trust/role |
| --- | --- | --- | --- |
| `core` | `packages/core` | TS, shared | Slot constants, proxy classification, Arkiv schemas, status function, risky-calldata rules. Used by watcher, importer, web (and the Snap if built). |
| importer | `importer/` | Node 22+ | Mirrors registry → Swarm + Arkiv. Re-runnable and idempotent. Signs with the **writer** wallet. |
| watcher | `watcher/` | Node 22+ | Event scan + slot polls; writes state records. Signs with the **watcher** wallet. |
| rebaseline CLI | `watcher/` (`npm run rebaseline`) | Node | Only thing that writes `baseline`. Signs with the **writer** wallet (see decision D1). |
| contracts | `contracts/` | Foundry | ImplA/ImplB + OZ TransparentUpgradeableProxy on Sepolia for the demo; stretch: atomic guard. |
| web | `web/` | Browser | Primary UI. Live checks through Anon-RPC/Nym. |

Node version: SDK requires **Node ≥ 22.10** — VERIFIED (`@arkiv-network/sdk@1.0.1` README).
Local: Node v24.12.0, Foundry 1.5.1.

## 2. Arkiv

### 2.1 Platform facts (all from the installed `@arkiv-network/sdk@1.0.1` package unless noted)

| Fact | Value | Tag |
| --- | --- | --- |
| SDK | `@arkiv-network/sdk@1.0.1` (latest on npm, 2026-11-02); peer dep `viem` | VERIFIED (npm registry) |
| Testnet | Rabdi, chain ID **7794095**, `rabdi({ accessKey })` from `@arkiv-network/sdk/chains` | VERIFIED (SDK `dist/chains`) |
| RPC | `https://rpc.rabdi.db-chain.testnet.arkiv.network`, WS `wss://rpc.rabdi.db-chain.testnet.arkiv.network` | VERIFIED (SDK `dist/chains`) |
| Explorer | `https://rabdi.explorer.arkiv.network` | VERIFIED (SDK) |
| Faucet / access keys | `hub.arkiv.network/faucet`, `hub.arkiv.network/access-keys`; public RPC "heavily rate limited" | VERIFIED (SDK README) |
| Data model | Entity = typed attributes (`bool,i32,u64,u256,dec,str,addr,key,bytes`), `.indexed()` per column (not `bytes`). **No separate payload field**, but a `bytes` attribute can hold up to 128 KiB. | VERIFIED (SDK README) |
| Limits | `MAX_ATTRIBUTES = 32`, `MAX_BYTES_LENGTH = MAX_ENTITY_BYTES = 128 KiB` | VERIFIED (SDK consts) |
| String attr limit | >128 B string rejected | VERIFIED empirically (spike S1); exact limit ASSUMED |
| Names | On-chain `Ident32` grammar; cannot start with `$`; `arkiv.schema` reserved. We use lowercase snake_case and call `validateAttributeName` in a unit test. | VERIFIED (SDK source comments); exact grammar ASSUMED |
| Named schema | `defineSchema("name", {...})` tags entities with indexed `arkiv.schema`; queries through it filter by tag | VERIFIED (SDK README) |
| Writes | `createEntity`, `patchEntity`, `extendEntity`, `deleteEntity`, `changeOwnership` | VERIFIED (SDK `.d.ts`) |
| Batch writes | `executeBatch({ creates, patches, deletes, extensions, ownershipChanges })`, one tx | VERIFIED (SDK types; Test 2) |
| Whether `patchEntity` can also set a new expiry | **No**: "a patch never moves … the expiry". Pair it with an extension in one `executeBatch` | VERIFIED (SDK types; Test 2) |
| Expiry helpers | `ExpirationTime.fromSeconds/Minutes/Hours/Days/Blocks` | VERIFIED (SDK) |
| Block time | 2 s | VERIFIED (SDK `BLOCK_TIME`) |
| Max lifetime | **7,884,000 blocks ≈ 182.5 days** from the create/extend block; longer reverts `ExpiryBeyondMaxLifetime` | VERIFIED (SDK `MAX_LIFETIME` doc comment) |
| Query | `select({...}).from(Schema).where(and(eq(..),..)).ownedBy(addr).orderBy(asc("$key")).limit(n).fetch()`; system fields `$key,$owner,$creator,$createdAt,$updatedAt,$expiresAt`; `where` accepts `$creator` | VERIFIED (SDK README) |
| Page size | `MAX_LIMIT = 100`; page by `gt("$key", key(last))` for stable full scans | VERIFIED (SDK) |
| Non-conforming rows | skipped and counted in `page.skipped` (anyone can write matching entities) | VERIFIED (SDK README) |
| Keyless reads from a browser | spike: 200 keyless queries, no 429; passthrough worker reached Arkiv from a null-origin iframe (implies permissive CORS) | VERIFIED empirically (spike); may change → Test 2 |
| Arkiv RPC through Nym exit | **did not answer** (0/25) | VERIFIED empirically (spike S2) |

### 2.2 Wallets and trust

- **writer** wallet: `descriptor`, `deployment`, `baseline` entities.
- **watcher** wallet: `current_state`, `latest_change` entities.
- Clients filter on `$creator` (not `$owner`, which can be transferred) against the two
  addresses hard-coded in `packages/core/src/trust.ts` and listed in the README. Rows from
  other creators are ignored even if they match the schema tag.
- **Decision D1 (needs your OK):** baseline is signed by the *writer* wallet, not the watcher,
  so a compromised or buggy watcher can never move a baseline. This deviates slightly from
  "separate watcher wallet for state records". The alternative is a third "admin" wallet.

### 2.3 Entities

All schemas are named, prefixed `dg_` so `arkiv.schema` tags never collide with other teams.
`chain_id` is `u64`, addresses `addr`, 32-byte hashes `key` (ASSUMED: `key` = 32-byte
value; fallback `str` of 66 chars), timestamps `u64` unix seconds. ⓘ = indexed.

**`dg_descriptor`** — one per registry descriptor file (mirror). Writer. Expiry: max lifetime
(≈182 days), renewed by `npm run renew`.

| attr | type | notes |
| --- | --- | --- |
| `descriptor_hash` ⓘ | key | ERC-8176 hash = keccak256(JCS(resolved descriptor)). |
| `registry_path` ⓘ | str | e.g. `registry/kiln/calldata-....json` (≤128 B; check longest path in importer). |
| `registry_commit` ⓘ | str | 40-hex commit SHA the import pinned. |
| `entity_dir` ⓘ | str | registry folder (`kiln`, `uniswap`, …). |
| `kind` ⓘ | str | `calldata` \| `eip712`. |
| `swarm_ref` | str | 64-hex Swarm reference of the JCS bytes, or `""` in fallback mode. |
| `storage_mode` ⓘ | str | `swarm` \| `registry` (fallback). |
| `size_bytes` | u64 | Size of the JCS bytes. |
| `file_sha` | key | keccak256 of the raw registry file bytes (lets anyone check against GitHub). |
| `schema_version` | str | `$schema` field (v1/v2). |
| `owner_name` | str | `metadata.owner`, if present (truncated to 128 B). |
| `imported_at` | u64 | |

**`dg_deployment`** — one per `(chain_id, address, descriptor)` from `context.contract.deployments`
(calldata) or `context.eip712.deployments`. Writer. Same expiry/renewal as above.
Spike S3: 2062 unique deployment keys.

| attr | type | notes |
| --- | --- | --- |
| `chain_id` ⓘ | u64 | |
| `address` ⓘ | addr | checksummed in UI, stored as addr. |
| `descriptor_hash` ⓘ | key | join to `dg_descriptor`. |
| `registry_commit` ⓘ | str | |
| `proxy_kind` ⓘ | str | importer's classification at import time: `eip1967` \| `beacon` \| `diamond` \| `safe` \| `none` \| `unknown` \| `unchecked` (only chains we have an RPC for are classified). |
| `monitored` ⓘ | bool | true if the watcher has a baseline for it. |

**`dg_baseline`** — the trust anchor per monitored contract. Writer. **Never auto-replaced**;
only `npm run rebaseline -- --chain <id> --address <addr> --reason "<text>"` changes it, and
that writes a new entity and deletes the old one (history kept in `rebaseline_reason`,
`previous_baseline_key`). Expiry: max lifetime, renewed by `npm run renew`.

| attr | type | notes |
| --- | --- | --- |
| `chain_id` ⓘ, `address` ⓘ | u64, addr | |
| `proxy_kind` ⓘ | str | as above. |
| `implementation` | addr | EIP-1967 impl, beacon's `implementation()`, or Safe singleton; zero for diamond/none. |
| `implementation_codehash` | key | `extcodehash(implementation)` (or of the address itself for `none`). |
| `admin` | addr | EIP-1967 admin slot (zero if unset). |
| `beacon` | addr | EIP-1967 beacon slot (zero if unset). |
| `facets_hash` | key | diamonds only: keccak256 of sorted `(facet, sorted selectors[])` from `facets()`. |
| `code_identity` ⓘ | key | single hash over all the fields above, used for equality checks. |
| `descriptor_hash` ⓘ | key | descriptor in force when baselined. |
| `swarm_ref` | str | |
| `baseline_block` | u64 | |
| `baselined_at` | u64 | |
| `rebaseline_reason` | str | `""` for the first baseline. |
| `previous_baseline_key` | str | `""` for the first baseline. |

**`dg_current_state`** — liveness + current view. Watcher. **Short expiry**. Slot reads every
60 s; the entity is rewritten **every 120 s, or immediately when anything changed**. Expiry
**10 min** (= 300 Arkiv blocks); GREEN staleness 5 min, so a single missed write never turns a
contract NOT VERIFIED, but a dead watcher does within 5 minutes. If the watcher dies, the
entity expires and the UI falls to NOT VERIFIED — this is the visible Arkiv-expiry feature.
Rewrite = `patchEntity` + `extendEntity` (or a create if it already expired; ASSUMED → Test 2).

| attr | type | notes |
| --- | --- | --- |
| `chain_id` ⓘ, `address` ⓘ | u64, addr | |
| `implementation`, `implementation_codehash`, `admin`, `beacon`, `facets_hash` | as baseline | current values. |
| `code_identity` ⓘ | key | |
| `matches_baseline` ⓘ | bool | `code_identity == baseline.code_identity`. |
| `ever_changed_since_baseline` ⓘ | bool | sticky: once true, only a rebaseline clears it. So A→B→A stays true. Derived from the persisted cursor state, not only the current read. |
| `checked_block` | u64 | block of the last slot read. |
| `checked_at` | u64 | unix s of the last slot read. |
| `last_scanned_block` | u64 | event cursor position for this chain. |
| `detection` | str | `event+slot` \| `slot-only` \| `unsupported`. |
| `baseline_key` | str | entity key of the baseline it compared against. |

**`dg_latest_change`** — newest detected change per contract. Watcher. Replaced (patched) when a
newer change is detected, never on a routine cycle. Long expiry + renewal.

| attr | type | notes |
| --- | --- | --- |
| `chain_id` ⓘ, `address` ⓘ | u64, addr | |
| `field` ⓘ | str | `implementation` \| `admin` \| `beacon` \| `facets` \| `singleton` \| `codehash`. |
| `previous_value`, `new_value` | str | address or hash as 0x-hex. |
| `change_block` | u64 | from the event, or the first poll block that saw it (then `tx_hash = ""`). |
| `tx_hash` | str | |
| `detected_at` | u64 | |
| `detected_by` ⓘ | str | `event` \| `slot`. |

### 2.4 Update and expiry rules (summary)

| Entity | Writer | Created | Updated | Expiry | Renewal |
| --- | --- | --- | --- | --- | --- |
| descriptor, deployment | writer | importer | importer re-run (upsert by `descriptor_hash`/`(chain,address,descriptor_hash)`; unchanged rows untouched) | ≈182 d | `npm run renew` |
| baseline | writer | `rebaseline` | never in place; replace only via `rebaseline` | ≈182 d | `npm run renew` |
| current_state | watcher | first cycle | every 120 s, or at once on change; one batched write per cycle where the SDK allows | 10 min | implicit: every write |
| latest_change | watcher | first change | on newer change | ≈182 d | `npm run renew` |

`renew` extends anything with `$expiresAt` closer than 30 days, and is safe to run anytime.

### 2.5 Client read (contract-independent)

On page load the web app does **one bulk read per trusted creator**: all `dg_baseline`,
`dg_current_state`, `dg_latest_change` rows (paged by `$key`, 100/page; expect fewer than 100
monitored contracts, so 1 page each). It then filters by contract client-side. Arkiv therefore
learns "someone loaded DriftGuard", not which contract they care about. `dg_descriptor` /
`dg_deployment` (≈2.8k rows) load lazily the same way only on the Browse page. This direct read
is the **one disclosed exclusion** from Anon-RPC (Arkiv's RPC doesn't answer through the Nym
exit, per spike S2).

## 3. Swarm

| Fact | Value | Tag |
| --- | --- | --- |
| Client | `@ethersphere/bee-js@13.2.0` (`bee.data.upload(batchId, bytes)` → `POST /bytes`; `bee.data.download(ref)` → `GET /bytes/:ref`) | VERIFIED (bee-js README) |
| Uploads need a postage batch | "all uploads require a paid postage batch"; `bee.storage.buy(Size, Duration)` | VERIFIED (bee-js README) |
| Upload needs a light/full Bee node (not ultra-light) | README endpoint table marks uploads ❌ for the first node mode | VERIFIED (bee-js README) — column meaning ASSUMED |
| Public gateway `api.gateway.ethswarm.org` | `/health` → 200 OK today; downloads OK; whether it accepts uploads without our own stamp is unknown | VERIFIED reachable; uploads ASSUMED → Test 1 |
| Stamp cost / how to get xBZZ + xDAI on Gnosis, or a hackathon-provided batch | unknown | ASSUMED → Test 1 (ask the Swarm booth) |
| Bonus doc | `/arkiv/swarm.md` with batch ID, buyer wallet, Bee node used, entity key + openable ref, run steps, video timestamp, friction | VERIFIED (prize page) |
| Encrypted refs leak their key | so we upload **unencrypted** (descriptors are public CC0 data anyway) | VERIFIED (prize page) |

**Flow (importer):**
1. `git` checkout of the registry at a pinned commit (`REGISTRY_COMMIT` in `importer/config.ts`).
2. For each `calldata-*.json` / `eip712-*.json`: resolve `includes` with the library's resolver
   (`resolveCalldataDescriptor` / `resolveTypedDataDescriptor` — ASSUMED usage → Test 1).
3. `bytes = JCS(resolved)` with `canonicalize@5.1.0` (RFC 8785 reference implementation, erdtman).
4. `descriptor_hash = keccak256(bytes)`; cross-check `== computeDescriptorHash(resolved)` from
   `@ethereum-sourcify/clear-signing@0.3.1` (which documents itself as the ERC-8176 hash). If
   they ever disagree, the import aborts — our JCS must match the library's.
5. If a `dg_descriptor` with that hash already exists from the writer: skip (idempotent).
   Otherwise `bee.data.upload(batch, bytes)` → `swarm_ref`; then create the Arkiv entity.
   New registry version = new hash = new upload + new entity; nothing is overwritten.
6. Deployments are upserted.

**Hash definition (VERIFIED, [EIP-8176](https://eips.ethereum.org/EIPS/eip-8176)):** resolve
`includes` per ERC-7730 merge rules → serialize with RFC 8785 JCS → Keccak-256 (not NIST
SHA3) → `0x` + 64 lowercase hex. Because we upload exactly the JCS bytes, **one hash covers
both** "is this the bytes Swarm returned" and "is this the ERC-8176 descriptor", and it matches
the hash auditors attest in the registry's `sigs/`.

**Verify on read (web + importer):** download → `keccak256(bytes) == descriptor_hash` from a
trusted Arkiv row → else reject and show NOT VERIFIED. The web app fetches Swarm through the
Nym worker (`worker.fetch` to the gateway's `/bytes/:ref`) so the gateway doesn't learn the
user's IP (ASSUMED the gateway answers Nym exits → Test 4 add-on).

**Fallback (if uploads are blocked):** `storage_mode = "registry"`, `swarm_ref = ""`;
readers fetch `raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/<commit>/<path>`,
resolve includes, and check `computeDescriptorHash` against `descriptor_hash`. Reported in
`arkiv/swarm.md` and README; we'd lose the Swarm bonus, not the main track.

## 4. Watcher

### 4.1 Detection matrix

| Proxy type | Events (on proxy unless noted) | Slot / call poll | Classification |
| --- | --- | --- | --- |
| EIP-1967 transparent (OZ) / UUPS | `Upgraded(address indexed implementation)`, `AdminChanged(address previousAdmin, address newAdmin)` | impl slot `0x3608…2bbc`, admin slot `0xb531…6103` | **event + slot** |
| EIP-1967 beacon proxy | `BeaconUpgraded(address indexed beacon)` on proxy; `Upgraded(address indexed)` on the **beacon** | beacon slot `0xa3f0…3d50`, then `beacon.implementation()` | **event + slot** (watch both addresses) |
| EIP-2535 diamond | `DiamondCut(FacetCut[] _diamondCut, address _init, bytes _calldata)` | loupe `facets()` → `facets_hash` | **event + poll** (if loupe present; otherwise event-only and flagged) |
| Safe proxy (singleton at slot 0) | `ChangedMasterCopy(address)` exists only in old Safe versions (≤1.1.x); in ≥1.3 the singleton changes only via a delegatecall writing slot 0, with no event | storage slot 0 | **slot-only** for ≥1.3 (event detection where it exists — ASSUMED versions) |
| Non-upgradeable / EIP-1167 clone | — | `extcodehash(address)` | **slot-only** (codehash catches redeploys) |
| Custom-slot / getter-only proxies (e.g. Compound `implementation()` storage, pre-1967 slots) | varies | — | **unsupported** → always NOT VERIFIED with reason "unsupported proxy pattern" |

Slot constants (VERIFIED, [EIP-1967](https://eips.ethereum.org/EIPS/eip-1967)):
`impl = bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)`,
`admin = …('eip1967.proxy.admin') - 1`, `beacon = …('eip1967.proxy.beacon') - 1`. Full values are
asserted against `keccak256` in a unit test, not hand-typed. Spike S4 resolved 15/15 targets with
slot reads (3 diamonds, 4 beacons, 1 transparent).

### 4.2 Loop

```
load cursor.json  (per chain: last_scanned_block; per contract: last seen identity, ever_changed)
loop every 60 s:
  head = latest block - CONFIRMATIONS (Sepolia: 2; mainnet: 2)
  for range in chunks(last_scanned_block+1 .. head, 2_000 blocks):
     eth_getLogs(addresses = monitored proxies + beacons, topics = [Upgraded, AdminChanged,
                 BeaconUpgraded, DiamondCut, ChangedMasterCopy])
     for each log: write latest_change (detected_by=event, tx_hash), set ever_changed if the new
                   identity != baseline
     persist cursor after each chunk (write temp file + rename = atomic)
  for each monitored contract: slot reads at `head` → identity
     if identity != last seen and no event explained it → latest_change (detected_by=slot)
     ever_changed |= identity != baseline.identity
  if anything changed OR now - last_write >= 120 s:
     upsert all current_state rows (checked_block=head, checked_at=now, last_scanned_block),
     batched into as few transactions as the SDK allows
```

**Scope (approved D3 + cap):** at most **~30 mainnet proxy contracts** from the registry,
preferring deployments whose descriptor has an auditor attestation in `sigs/`, plus the
Sepolia demo proxy.

- **Restart:** cursor is on disk (`watcher/state/cursor.json`, gitignored). On a missing cursor the
  watcher starts at the baseline block, so a restart never skips a range. `ever_changed` is also
  rebuilt from Arkiv's `current_state` / `latest_change` if the local file is lost (it never goes
  true → false except via rebaseline).
- **Reorgs:** `CONFIRMATIONS` lag. A reorg deeper than that can produce a stale `latest_change`;
  the next slot read corrects `current_state` (documented limitation).
- **RPC:** ordinary RPC for the watcher (Sepolia + mainnet endpoints from `.env`). The watcher's
  RPC provider learns which contracts we monitor; that is public anyway (it's on Arkiv).

## 5. Companion web app + Anon-RPC / Nym

### 5.1 Facts

| Fact | Value | Tag |
| --- | --- | --- |
| Harness | `@anon-rpc/browser-harness@0.4.0` (latest, 2026-10-23; implements spec 0.4.0). **Spike used 0.3.2**; 0.4.0 breaking change: `config` must be a plain value. | VERIFIED (package CHANGELOG) |
| API | `new AnonRpcWorker({ address, config?, preExisting: { rpcProvider }, iframeUrl? })`, `await worker.ready`, `worker.fetch(url, init)` (standard fetch; `anonOptions.isolationKey` per call), `worker.acceptLog()`, `worker.close()` | VERIFIED (package README) |
| Isolation | bundle fetched via on-chain specifier, `keccak256(bytes) == workerHash()` checked before execution; runs in a Web Worker in a null-origin sandboxed iframe | VERIFIED (package README) |
| Nym specifier | `0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0` on **Ethereum mainnet** (specifier chain = where the bootstrap RPC reads it, *not* the chain the fetch can reach) | VERIFIED ([adopters.json5](https://github.com/ethereum/anon-rpc/blob/main/adopters.json5)) |
| Nym bundle / boot | ~18 MB; "a few seconds to bootstrap"; exits at a Nym IP Packet Router | VERIFIED (adopters.json5); spike: boot 10 s, 30/30 ok, p50 662 ms, p95 2.9 s |
| CSP | default `srcdoc` bootstrap needs `'unsafe-inline'` script-src, or serve `dist/iframe-boot.js` via `iframeUrl` | VERIFIED (package README) |
| Sepolia RPC answers Nym exit traffic | unknown per provider | ASSUMED → Test 4 |
| Prize rule | "Your app routes its RPC reads through Anon-RPC by default"; disclose excluded traffic | VERIFIED (prize page) |

### 5.2 What goes through Nym (default ON)

| Traffic | Route | Why |
| --- | --- | --- |
| Live checks: `eth_getStorageAt` (impl/admin/beacon/slot 0), `eth_getCode`/codehash, `eth_call` (`implementation()`, `facets()`) | **Nym** | reveals which contract the user is about to interact with |
| Token metadata for rendering (`decimals`, `symbol` via `eth_call`) | **Nym** | same |
| Descriptor JSON from Swarm gateway | **Nym** | reveals which dapp |
| Specifier read (bootstrap) | direct mainnet RPC, once | unavoidable bootstrap; reveals only "loads the Nym worker" |
| Arkiv bulk read | direct, keyless, once per load, contract-independent | Arkiv RPC doesn't answer via Nym exit; mitigated by the bulk read. **Disclosed.** |
| Static app assets | the web host | standard |

Optional per-contract `isolationKey` so successive checks aren't linkable (support varies by network).

### 5.3 Screens
1. **Monitored contracts** — table: chain, address, dapp, proxy kind, detection mode, badge,
   baseline impl vs current impl, latest change (block, tx link), descriptor hash + Swarm link.
2. **Check a transaction** — paste either a raw tx hex (`0x02…`, decoded with viem
   `parseTransaction`) or `{to, data, chainId}`. Shows: readable intent from
   `format(tx, { descriptorResolverOptions: { type: "custom", resolver } })` where the resolver's
   `fetchDescriptor` returns Swarm-verified JSON; the badge; the live Nym check result; risky-calldata
   flags.
3. **Nym diagnostics** — boot time, per-call latency, success count; "Run 20 reads" (Test 4).

### 5.4 Status function (`packages/core/src/status.ts`, pure and unit-tested)

Inputs: trusted baseline, trusted current_state (+ `$expiresAt`), latest_change, optional live
read, `now`.

- **RED — "Monitored change detected"** if any trusted source shows `code_identity !=
  baseline` *now*: `current_state.matches_baseline == false`, or the live Nym read differs from
  the baseline.
- **GREEN — "Verified recently, no change"** only if baseline exists AND current_state exists, isn't
  expired, `now - checked_at ≤ 5 min` AND `matches_baseline` AND (live read absent or equal to
  baseline).
- **NOT VERIFIED** otherwise, with a reason: not monitored / no baseline / watcher record expired /
  stale (> 5 min) / unsupported proxy pattern / live read failed / live read disagrees with
  watcher (but equals baseline).
- Extra line when GREEN-or-matching and `ever_changed_since_baseline`: **"Matches baseline now, but
  a change was previously detected (block N)."**
- Copy rules: "change detected", never "malicious", "unsafe", or "attack".

### 5.5 Risky-calldata flags (independent of descriptors)

Selectors computed with viem `toFunctionSelector` in a unit test: `upgradeTo(address)`,
`upgradeToAndCall(address,bytes)`, ProxyAdmin `upgrade(address,address)` / `upgradeAndCall(address,address,bytes)`,
`changeMasterCopy(address)`, `diamondCut(...)`, and Safe `execTransaction(...)` with
`operation == 1` (delegatecall). These show "This transaction changes contract code / delegates
execution" — informational.

## 6. TOCTOU and other limitations (stated plainly in the README)

1. **Check ≠ execution.** Every status is as of block N. An upgrade can land between our read
   and the user's signature, or in the same block before the user's transaction (including a
   deliberate front-run). GREEN means "no change seen as of block N", not "safe at execution".
2. **Watcher latency.** Detection lags by up to one cycle (60 s) + confirmations (≈2 blocks).
   The live Nym read narrows this to seconds but not to zero.
3. **Liveness ≠ correctness.** A live watcher can still be wrong (RPC lies). The live Nym read
   is a second, independent source. Neither is proof.
4. **Upgrades are not malicious by default.** RED says a change happened since baseline, and asks
   the user to check whether the descriptor still describes the new code. That's all.
5. **Coverage.** Only the patterns in §4.1 marked event or slot. Unsupported proxies are always
   NOT VERIFIED, never GREEN.
6. **Descriptor itself.** We verify a descriptor is the one the registry published (hash); we
   don't audit whether it's correct. ERC-8176 attestations are the tool for that (the library
   supports them; we may surface them if time permits).
7. **Atomic guard limits (stretch).** A contract can't generically read another contract's
   EIP-1967 slot. Solidity has no `EXTSLOAD` opcode, so it would need the target to expose a
   getter, and transparent proxies hide admin functions from non-admins. So a check-and-call
   guard only works for proxies that expose a trustworthy implementation getter (our demo proxy).
8. **Snap (stretch).** The harness is browser-only (null-origin iframe + WebRTC transport) —
   VERIFIED (package README "Notes"). A Snap has no DOM or iframe, so a Snap would use direct RPC
   and be documented as outside Anon-RPC traffic. To be re-checked against MetaMask Snaps docs
   before building.

## 7. Package pins (exact, decided at install time, recorded here)

| Package | Version | Basis |
| --- | --- | --- |
| `@arkiv-network/sdk` | 1.0.1 | latest; spike-tested |
| `viem` | 2.56.3 | spike-tested with Arkiv 1.0.1 + harness (latest is 2.57.16; upgrade only if needed) |
| `@anon-rpc/browser-harness` | 0.4.0 | latest; 0.3.3 fallback if 0.4.0 regresses in Test 4 |
| `@ethereum-sourcify/clear-signing` | 0.3.1 | latest; spike-tested |
| `@ethersphere/bee-js` | 13.2.0 | latest |
| `canonicalize` | 5.1.0 | latest (RFC 8785 reference impl) |
| `@openzeppelin/contracts` (Foundry lib) | v5.6.1 | latest |
| `vite` / `react` | chosen in Test 4 (a release ≥ 2 weeks old) | — |

## 8. Repo layout

```
contracts/        Foundry: ImplA, ImplB, deploy + upgrade scripts (Sepolia)
packages/core/    shared TS: slots, classify, schemas, status, risky calldata, trust
watcher/          event scan + slot poll + rebaseline + renew
importer/         registry → Swarm + Arkiv
web/              React + Vite companion
arkiv/            prize docs (schema, friction, reach, why-arkiv, data-quality, swarm)
docs/             ARCHITECTURE.md, test reports
```
npm workspaces; TypeScript run with `node --experimental-strip-types` where possible (no build
step for jobs).

## 9. Unverified assumptions (to close during risk tests)

| # | Assumption | Closed by |
| --- | --- | --- |
| A1 | ~~OZ 5.x proxy deploys its own ProxyAdmin; upgrades via `ProxyAdmin.upgradeAndCall`~~ **CLOSED: VERIFIED** in OZ v5.6.1 source. New: 5.6 refuses empty init data | Test 3 |
| A2 | ~~Sepolia RPC supports `eth_getLogs` over 2k-block ranges~~ **CLOSED: VERIFIED** with an address filter (PublicNode rejects unfiltered calls, -32001 on lagging backends is retried) | Test 3 |
| A3 | A Sepolia RPC endpoint answers requests from the Nym exit; ≥18/20 and p95 < ~10 s through harness 0.4.0 | Test 4 |
| A4 | Swarm gateway answers through Nym | Test 4 add-on |
| A5 | ~~Arkiv batch write / patch vs expiry / `key` type~~ **CLOSED: VERIFIED** `executeBatch({creates,patches,deletes,extensions})` in one tx; a patch never moves expiry (pair with an extension); hashes stored as `str` | Test 2 |
| A6 | ~~Keyless browser reads un-throttled~~ **CLOSED, partly FALSE:** keyless reads have a cost budget (429 `ANON_COST_LIMITED`, limit 10000, reset ~217 s). A single bulk read per page load is fine; the watcher and importer use an access key | Test 2 |
| A7 | ~~Expired entities leave queries promptly~~ **CLOSED: VERIFIED** 2-minute entity gone after ~94–102 s of polling; 10-minute watcher row gone after the watcher stopped | Test 2, E2E |
| A8 | Swarm upload path: own Bee light node vs gateway vs hackathon-provided batch; stamp cost | Test 1 |
| A9 | `resolveCalldataDescriptor` resolves `includes` for a registry file loaded from disk; our `canonicalize` output hashes equal to `computeDescriptorHash` | Test 1 |
| A10 | Largest registry descriptor (spike: 1 file > 128 KiB) uploads and round-trips | Test 1 |
| A11 | Safe versions with `ChangedMasterCopy` | read Safe sources before the watcher build; until then Safe = slot-only |
| A12 | ~~Registry issues #2975/#3098 say what we cite~~ **CLOSED, corrected:** #3098 lists an external monitoring tool as an alternative; #2975 is about EIP-712 domain drift on upgrade (not yet covered by DriftGuard) | re-read 2026-11-06, see §0 and `arkiv/reach.md` |
| A13 | Mirror-track eligibility: registry data is CC0 and not Sourcify data (the clear-signing *library* is published by Sourcify, but the mirrored *data* is the EF registry) | confirm with Arkiv booth; fallback = Build on Arkiv (rename `data-quality.md` → `how-you-use-arkiv.md`) |
| A14 | Registry default branch is `master` | importer pins a commit SHA anyway |

## 10. Decisions (approved 2026-11-06)

- **D1** Baseline is signed by the writer wallet; the watcher wallet can never move a baseline.
- **D2** Slot reads every 60 s; current_state written every 120 s or on change; expiry 10 min;
  GREEN staleness 5 min.
- **D3** Watch the Sepolia demo proxy + up to ~30 mainnet registry proxies (attested first).
  Other chains are mirrored, not watched.

## 11. Wallets and RPC

| Role | Address |
| --- | --- |
| writer (importer, baselines) | `0x623EdFf351EB13aCCFc56cBf541eE4D45BDADCf4` |
| watcher (current_state, latest_change) | `0x8a883182b488cE04f08D348C64d9AC8EecACF2Bf` |
| Sepolia deployer (demo proxy) | `0x060762aa5D602d1A6E9a5AecC3301cf804b7E42C` |

Keys live only in the gitignored `.env`. Default RPCs are PublicNode (Sepolia, mainnet), which
**rejects `eth_getLogs` without an `address` filter** (error -32701) — VERIFIED 2026-11-06. The
watcher always filters by address, so this is fine.
