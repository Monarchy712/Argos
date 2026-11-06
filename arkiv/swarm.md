# Arkiv + Swarm

Argos keeps the **content** of every ERC-7730 descriptor on Swarm and the **facts about it**
(which file, which commit, which hash, who attested it, where it's deployed, whether the code
behind it changed) on Arkiv. The web app fetches the descriptor from Swarm by the reference on
the Arkiv row, and renders it only if its hash matches that row.

## What lives where

| | Swarm | Arkiv |
| --- | --- | --- |
| What | The **resolved** descriptor (includes merged) as **RFC 8785 JCS bytes**, one upload per descriptor: **746** (617 calldata + 129 EIP-712), 2.42 MB total | `dg_descriptor` (768 rows: metadata + the Swarm reference), `dg_deployment` (2,675), `dg_baseline`, `dg_current_state`, `dg_latest_change` |
| Why | Content-addressed and served by any gateway or Bee node: the bytes don't depend on GitHub or on us | Queryable, owned by our writer wallet (`$creator`), with expiry as the freshness signal |
| Field holding the reference | | **`dg_descriptor.swarm_ref`** (64-hex, unencrypted), with `storage_mode = "swarm"` |

**One hash ties them together.** Because we upload exactly the JCS bytes of the resolved
descriptor, `keccak256(bytes from Swarm)` *is* the descriptor's ERC-8176 hash, the same hash
auditors sign in the registry's `sigs/` and that we store as `dg_descriptor.descriptor_hash`.
So a single check proves "Swarm returned the right bytes" and "this is the descriptor the registry
and auditors mean". The 22 include files stay `storage_mode = "registry"`: they have no ERC-8176
hash of their own and are already merged into the resolved descriptors on Swarm.

**No encrypted references on Arkiv.** Descriptors are public CC0 data, so we upload unencrypted.
The importer asserts every reference is 64 hex characters. An encrypted reference (128 hex) embeds
its decryption key, and Arkiv entities are public.

## Example: one entity and its Swarm reference

Aave v3 Pool (mainnet `0x87870bca…4fa4e2`, a monitored EIP-1967 proxy), `registry/aave/calldata-lpv3.json`:

| | |
| --- | --- |
| Arkiv entity (`dg_descriptor`) | [`0x495d23d3c4677d440698729634c5557cbd71b106abf9d1d805e10cf57bdee4f8`](https://rabdi.explorer.arkiv.network/entity/0x495d23d3c4677d440698729634c5557cbd71b106abf9d1d805e10cf57bdee4f8) (`storage_mode = swarm`) |
| `swarm_ref` | `7d65ee6ba97951c31444de4d7e88ce768fc8eaf1887966e3b451c10b2af63a04` |
| Open it on Swarm | <https://api.gateway.ethswarm.org/bytes/7d65ee6ba97951c31444de4d7e88ce768fc8eaf1887966e3b451c10b2af63a04> |
| `descriptor_hash` (ERC-8176) | `0xf11301c71b26b892d49d820260f565cc776d8d54c89538f6b439272519322683` = keccak256 of the bytes above |

Check it yourself:

```bash
curl -s https://api.gateway.ethswarm.org/bytes/7d65ee6ba97951c31444de4d7e88ce768fc8eaf1887966e3b451c10b2af63a04 -o lpv3.json
node -e 'const {keccak256,toHex}=require("viem");console.log(keccak256(toHex(require("fs").readFileSync("lpv3.json"))))'
# → 0xf11301c71b26b892d49d820260f565cc776d8d54c89538f6b439272519322683
```

## Postage batch and upload path

| | |
| --- | --- |
| Uploaded through | the public Swarm gateway **`https://api.gateway.ethswarm.org`** (`POST /bytes`), Nov 6 2026 ~09:03 IST |
| Postage batch | **the gateway's own.** We sent no `swarm-postage-batch-id`; the gateway stamped the uploads and returned `201`. Its response doesn't name the batch, so we can't give its ID or buyer (see *What got in our way*). |
| Our own batch | Not used yet: the Swarm booth batch details were not in `.env` at upload time. To move the content under it: set `BEE_API_URL` and `SWARM_POSTAGE_BATCH_ID` in `.env`, then run `npm run swarm -w importer -- ../.cache/registry --restamp`. It asserts every reference is unchanged. |

The references don't depend on the batch: an unencrypted Swarm reference is a hash of the
content. Re-stamping under another batch (`--restamp`) re-uploads the same bytes, gets the same
references, and changes nothing on Arkiv.

## Files that upload and read

| File | Role |
| --- | --- |
| [`importer/src/swarm.ts`](../importer/src/swarm.ts) | **Upload.** For each `dg_descriptor` row not yet on Swarm: JCS bytes → check keccak = `descriptor_hash` → `bee.data.upload(batch, bytes)` (`@ethersphere/bee-js@13.2.0`, `POST /bytes`) → download it back and check keccak again → patch the Arkiv row (`swarm_ref`, `storage_mode = "swarm"`, 20 patches per `executeBatch`). Resumable (refs cached in `importer/state/`), idempotent. `--restamp` re-uploads under our own batch and asserts each reference is unchanged. |
| [`importer/src/registry.ts`](../importer/src/registry.ts) | Produces the JCS bytes (resolves `includes` with the reference library, hashes two ways, aborts on mismatch). |
| [`web/src/lib/descriptors.ts`](../web/src/lib/descriptors.ts) | **Read.** `SwarmFirstSource`: `GET {gateway}/bytes/{swarm_ref}`, keccak must equal the Arkiv row's `descriptor_hash`. Network failure → registry fallback (labelled). Hash mismatch → rejected, never a fallback. |
| [`web/src/lib/mirror.ts`](../web/src/lib/mirror.ts) | Reads `swarm_ref` / `storage_mode` from the writer's `dg_descriptor` rows (bulk Arkiv read). |
| [`web/src/screens/CheckTx.tsx`](../web/src/screens/CheckTx.tsx) | Shows each fetched file tagged **Swarm** or **registry**, with a link to the Swarm URL. |

## Run one upload and one read yourself

Needs Node ≥ 22.10 and `npm ci`. No keys for the read.

```bash
# Read: the web app (Check → paste an Aave v3 supply; the provenance panel shows "Swarm ✓")
npm run dev                                  # http://localhost:5180

# Upload, dry run (no keys): plans which descriptors would go to Swarm
git -c core.autocrlf=false clone https://github.com/ethereum/clear-signing-erc7730-registry .cache/registry
git -C .cache/registry checkout ef582c2f03bfbd062b7e3889b55dd3b45c3d5494
npm run swarm -w importer -- ../.cache/registry --dry
# → {"msg":"plan","descriptors":746,"alreadyOnSwarm":746,"toUpload":0,...}

# Upload one descriptor through the public gateway without touching Arkiv (no keys):
npm run swarm -w importer -- ../.cache/registry --public-gateway --restamp --limit 1 --no-arkiv
```

What you should see for the upload: `uploads done … failed 0` and a `public gateway check` line
with `hashMatches: true`. The reference equals the one already on Arkiv, because unencrypted
Swarm references are content addresses.

Our full run: [`docs/test-runs/swarm-upload-gateway.txt`](../docs/test-runs/swarm-upload-gateway.txt).
746 uploads in 53 s, 0 failures, each downloaded back and keccak-checked, then 746 Arkiv patches.

## The app itself is on Swarm too

Descriptor content on Swarm protects the data. It doesn't help if the **frontend** disappears, so
the built app is published to Swarm as a browsable collection:

```bash
npm run build
node scripts/publish-site.ts          # no keys: stampless upload through the public gateway
```

Reference (build of 2026-11-06): **`9408348807abd83f6f85a84f6bf50c6664e802332dd8442c36cb815ffb73623d`**
· run log: [`docs/test-runs/swarm-site-publish.txt`](../docs/test-runs/swarm-site-publish.txt)

- **Deterministic.** The tar is built with sorted paths and zeroed mtime/uid/gid/mode, so the
  archive bytes — and therefore the reference — are a pure function of the file contents and
  names. Re-running on the same build returns the same reference; we verified that.
- **Verified on upload.** Every file is fetched back from the gateway and byte-compared. On the
  2026-11-06 run: 4/5 identical, with `index.html` refused (see below). Source maps are excluded
  by default (3.5 MB of a 4.7 MB build, not needed to run; `--with-maps` includes them).
- **What this does and doesn't buy.** If our host goes away, the app's bytes are still on Swarm,
  content-addressed, and anyone running a Bee node can serve them with `GET /bzz/<ref>/`. It does
  **not** make the app permanent: the gateway stamped this, and we can't see its batch or
  retention (see friction 2 below).

**Honest limit — you cannot click a link and see it.** The ethswarm public gateways are
*default-deny for websites*: a new reference serves non-HTML assets straight away but 302s HTML to
`bzz.link/forbidden` until a moderator approves the hash. That is their anti-phishing policy and
we're not going to work around it. So right now:

```bash
# an asset serves from the public gateway immediately (200, byte-identical):
curl -s https://api.gateway.ethswarm.org/bzz/9408348807abd83f6f85a84f6bf50c6664e802332dd8442c36cb815ffb73623d/assets/ccip-Cj98csXV.js | head -c 80

# the HTML does not, until the hash is approved:
curl -si https://api.gateway.ethswarm.org/bzz/9408348807abd83f6f85a84f6bf50c6664e802332dd8442c36cb815ffb73623d/ | head -1
# → HTTP/2 302 ... location: https://bzz.link/forbidden?hash=91c7ba…
```

Serve it yourself from any Bee node to see the whole app: `GET /bzz/<ref>/`.

## In the demo video

Moment (a) in [docs/VIDEO_SCRIPT.md](../docs/VIDEO_SCRIPT.md): **Check a transaction → Aave v3 supply**. The provenance panel
shows `Swarm ✓ registry/aave/calldata-lpv3.json · resolved JCS bytes match the ERC-8176 hash on
Arkiv`, and the tamper toggle then shows the same Swarm bytes rejected. Timestamp: see the video script; filled in after recording.

## What got in our way

1. **Getting a postage batch is the hard part at a hackathon.** Uploads need a paid batch, and
   buying one means xDAI + xBZZ on Gnosis plus a light (not ultra-light) Bee node. That isn't
   something you set up in an hour on venue Wi-Fi, so we depended on the Swarm booth for a batch.
2. **The public gateway accepts stampless uploads, but doesn't say whose stamp it used.**
   `POST https://api.gateway.ethswarm.org/bytes` with no `swarm-postage-batch-id` returned
   `201 {"reference": …}` and the content was immediately retrievable. That unblocked us. But the
   response doesn't name the batch, and we found no documented retention for gateway-stamped
   content, so we can't state a batch ID or how long the data lives. *Ask:* return the batch ID
   (or a TTL) in a response header, and document the gateway's upload policy.
3. **bee-js can't express a stampless upload.** `bee.data.upload(batchId, data)` requires a batch
   ID (`new BatchId(...)` validates it), so for the gateway path we call `POST /bytes` with
   `fetch`. bee-js is used for uploads with our own batch and for downloads.
4. **The version list is noisy.** `npm view @ethersphere/bee-js versions` ends in dozens of
   `13.x.x-upcoming.<hash>` builds, which makes "latest stable" harder to spot. We pinned 13.2.0
   to match the README we designed against.
5. **Public gateways are default-deny for websites, and nothing says so at upload time.** The
   upload returns `201` with a reference and the assets serve fine, so it looks like a success —
   then the HTML 302s to `bzz.link/forbidden` and you discover the moderation queue. Real projects
   hit this too ([safenet-staking-ui#141](https://github.com/safe-fndn/safenet-staking-ui/issues/141)).
   The policy is reasonable; the discovery path isn't. *Ask:* say so in the upload response (a
   header or a field saying the hash is pending website approval), and document the approval route
   next to the [host-your-website guide](https://docs.ethswarm.org/docs/develop/access-the-swarm/host-your-website/).
6. **What worked well:** content addressing. Re-uploading the same bytes gives the same reference,
   so the importer is idempotent for free, and moving content to another batch doesn't change a
   single Arkiv row. The gateway sends `Access-Control-Allow-Origin: *`, so the browser reads
   Swarm directly with no proxy.
