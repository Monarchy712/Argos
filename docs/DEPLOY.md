# Deploying Argos

Two deployable pieces, and they are deliberately separate:

| Piece | Where | Why there | Needs secrets? |
| --- | --- | --- | --- |
| **web** | **Vercel** | static files; free, CDN-served, zero config for a Vite build | **no** |
| **watcher** | **Railway** | a persistent process. Vercel only runs serverless functions that time out, so it cannot host this at all | **yes** — one key |

Don't put the site on Railway: it bills uptime for what is five static files, and Railway's $5
credit is better spent on the watcher. Don't try to put the watcher on Vercel: it is a loop that
must stay running.

The web service holds no keys and talks to nothing: the browser reads Arkiv, Swarm and the chain
itself. The watcher is the only part that signs anything.

---

## Why the watcher matters more than the website

If the **web host** dies, nothing is lost: the bundle is also on Swarm, and anyone can run
`npm ci && npm run dev` from this MIT repo with no keys.

If the **watcher** dies, every monitored contract reads **NOT VERIFIED** about five minutes later,
because its newest `dg_current_state` reading goes stale (`checked_at` older than 300 s) and the
`dg_watcher_health` heartbeat stops advancing. That is the intended fail-closed behaviour — Argos
would rather say "I don't know" than show a stale green — but it means a hosted site with a dead
watcher looks broken. Deploy the watcher, not just the site.

## Vercel (the web app)

The project's **Root Directory is `web`** (Settings → General). That one setting decides how
everything else in `vercel.json` is read, and getting it wrong is how this broke before:

- `vercel.json` is still read from the **repository root**, but `buildCommand` runs with the
  working directory set to `web/`, and `outputDirectory` resolves relative to `web/` too.
- So the correct values are `"buildCommand": "npm run build"` and `"outputDirectory": "dist"` —
  *not* `web/dist`, which would resolve to `web/web/dist`.
- A build command of `… && rm -rf dist && cp -r web/dist dist` fails for the same reason: run from
  `web/`, `rm -rf dist` deletes the output that was just built and the `cp` then has nothing to
  copy. Commit `babf37d` did exactly that, and every production deploy errored until it was
  reverted — the live site silently kept serving the last build that predated it.

Import the GitHub repo in Vercel, set Root Directory to `web`, and accept the rest. Installation
is left to Vercel so its dependency cache is used; `npm install` inside `web/` still resolves the
`@driftguard/core` workspace because the whole repo is cloned.

**No environment variables.** The browser does all the reading itself, which is the CROPS
"no keys needed" claim. Three optional overrides exist — `VITE_MAINNET_RPC_URL`,
`VITE_SEPOLIA_RPC_URL`, `VITE_SWARM_GATEWAY` — but their defaults are the same public endpoints,
so there is no reason to set them. If you ever do: anything prefixed `VITE_` is compiled into the
public bundle, so never put a keyed RPC URL there.

There are deliberately **no rewrites**. The app does have client-side routing now — the contract
workspace is `#/c/<chainId>/<address>/<tab>` — but it is **hash** routing, and a fragment is never
sent to the server: every URL is a request for `/`. That was the reason for choosing it, since the
same build is also published as a static Swarm collection, which cannot rewrite paths at all. A
catch-all rewrite to `index.html` would therefore buy nothing and would only hide genuine 404s.

`scripts/serve-static.ts` is not used by Vercel. It stays for self-hosting — see the last section.

## Railway (the watcher)

`railway.json` is the **watcher** config, because the watcher is the only thing Railway runs.
Railway reads that filename by default, so a service connected to this repo picks it up with no
config-as-code setting to hunt for. (`railway.web.json` is kept only for anyone who wants to host
the site on Railway too.)

### Steps

1. Create a Railway project with one service connected to this repo.
2. Do **not** generate a domain for it — the watcher has no HTTP port.
3. Set its variables (dashboard, not the CLI — a private key on a command line ends up
   in the process list):

   | Variable | Why |
   | --- | --- |
   | `ARKIV_WATCHER_PRIVATE_KEY` | **required.** Signs `dg_current_state` / `dg_latest_change`. This is the key that matters — see below |
   | `MAINNET_RPC_URL` | **required.** Reads the 30 mainnet proxies |
   | `SEPOLIA_RPC_URL` | **required.** Reads the 2 Sepolia demo proxies |
   | `ARKIV_ACCESS_KEY` | optional but recommended; avoids the keyless rate limit |

   Add nothing else. `ARKIV_RPC_URL` appears in `.env.example` but **no code reads it** — the
   endpoint comes from the SDK's `rabdi()` helper. `ARKIV_WRITER_PRIVATE_KEY`,
   `SEPOLIA_DEPLOYER_PRIVATE_KEY` and `ZEROG_API_KEY` are deliberately absent: the watcher never
   needs them, and every key you add is exposure bought for nothing.

4. Deploy, then confirm in the logs that cycles are running with `"failed":0`.

Run only **one** watcher at a time. Two processes signing with the same key race to write the
same `dg_current_state` rows, so stop the local one once Railway's is live.

### Two Nixpacks gotchas we hit, and why the config looks like it does

**`npm ci` fails the build.** Railway mounts a build cache at `/app/node_modules/.cache`, and
`npm ci` deletes `node_modules` wholesale before installing, so it tries to `rmdir` a live mount:

```
npm error EBUSY: resource busy or locked, rmdir '/app/node_modules/.cache'
"npm ci && npm run build" did not complete successfully: exit code 240
```

So both configs use `npm install --no-audit --no-fund`, which installs in place instead of wiping
the tree. The lockfile is still respected — verified locally that `npm install` leaves
`package-lock.json` byte-identical and the build output unchanged.

**Node version.** Several scripts are run as TypeScript directly (`node scripts/serve-static.ts`,
`node watcher/src/main.ts`), which relies on Node's built-in type stripping. That is only on by
default from Node 22.18 / 23.6 onward, and `engines.node` here is the range `>=22.10` — which a
builder is free to satisfy with 22.10, where those commands would fail to parse. `.nvmrc` pins
Node 24 so the deployed runtime matches the one we develop and test on.

### Note the start command has no `--env-file`

Locally the watcher runs as `node --env-file=.env watcher/src/main.ts`. On Railway the variables
come from the platform, so the start command is plain `node watcher/src/main.ts`. Keeping
`--env-file=.env` there would crash the container: there is no `.env` in the image, and there must
not be — `.env` is gitignored and never built in.

### Cursor persistence

The watcher stores its block cursor in `watcher/state/`. Railway's filesystem is ephemeral, so a
redeploy loses it and the watcher re-scans from each contract's baseline block. That is harmless
and self-correcting (we did exactly this on a fresh clone and it replayed cleanly), but the range
grows the longer a baseline has stood. For anything beyond a hackathon, attach a Railway volume at
`/app/watcher/state`, or set `WATCHER_STATE_DIR` to a mounted path.

## What deploying the watcher actually exposes

Be clear-eyed about this, because the whole trust model rests on it.

Argos asks readers to trust rows created by **two published addresses**: a writer (baselines, the
mirror) and a watcher (current state). Putting the watcher key on a host means that **whoever
controls the host can write `dg_current_state` rows claiming a contract matches its baseline.**
That is the realistic threat — not theft, since the key holds only testnet tGLM.

What that does *not* reach:

- **Baselines.** `dg_baseline` is signed by the **writer** key, which stays local and is never
  deployed. The trust anchor does not move.
- **The user's own live read.** The app cross-checks the watcher's claim against a slot read the
  visitor's browser makes itself. A forged "verified" row disagreeing with the live read shows as
  a conflict, not a green badge.
- **Descriptor integrity.** Descriptors are rendered only if their bytes hash to the ERC-8176 hash
  on Arkiv, and that hash is on a writer-signed row.

So a compromised watcher host can make Argos *stale or wrong about liveness*, and the app has two
independent ways to notice. It cannot silently rewrite what the baseline is.

## Serving it yourself instead

```bash
git clone https://github.com/Monarchy712/Argos && cd Argos
npm ci && npm run build
node scripts/serve-static.ts        # PORT=8080 by default
```

No keys, no accounts. The bundle is also on Swarm — see [`arkiv/swarm.md`](../arkiv/swarm.md) for
the reference and the gateway caveat.
