# Deploying Argos

Two deployable pieces, and they are deliberately separate:

| Service | What it is | Needs secrets? |
| --- | --- | --- |
| **web** | the built static app, served by [`scripts/serve-static.ts`](../scripts/serve-static.ts) | **no** |
| **watcher** | `watcher/src/main.ts`, the process that writes `dg_current_state` / `dg_latest_change` to Arkiv | **yes** — one key |

The web service holds no keys and talks to nothing: the browser reads Arkiv, Swarm and the chain
itself. The watcher is the only part that signs anything.

---

## Why the watcher matters more than the website

If the **web host** dies, nothing is lost: the bundle is also on Swarm, and anyone can run
`npm ci && npm run dev` from this MIT repo with no keys.

If the **watcher** dies, every monitored contract reads **NOT VERIFIED** about ten minutes later,
because `dg_current_state` rows expire. That is the intended fail-closed behaviour — Argos would
rather say "I don't know" than show a stale green — but it means a hosted site with a dead
watcher looks broken. Deploy the watcher, not just the site.

## Railway

Both services live in one Railway project. The repo carries two config files because a Railway
service picks one:

- `railway.json` → the **web** service (`npm ci && npm run build`, then `node scripts/serve-static.ts`)
- `railway.watcher.json` → the **watcher** service (`npm ci`, then `node watcher/src/main.ts`)

Point the watcher service at the second file with **Settings → Config-as-code →
`railway.watcher.json`**.

### Steps

1. Create an empty Railway project, then two services inside it named `web` and `watcher`.
2. Connect both to this GitHub repo.
3. On `watcher`, set config-as-code to `railway.watcher.json`.
4. Set the watcher's variables (dashboard, not the CLI — a private key on a command line ends up
   in the process list):

   | Variable | Why |
   | --- | --- |
   | `ARKIV_WATCHER_PRIVATE_KEY` | signs `dg_current_state` / `dg_latest_change`. **This key is the one that matters** — see below |
   | `ARKIV_RPC_URL` | Arkiv Rabdi endpoint |
   | `ARKIV_ACCESS_KEY` | optional, avoids the keyless rate limit |
   | `MAINNET_RPC_URL` | reads the 30 mainnet proxies |
   | `SEPOLIA_RPC_URL` | reads the 2 Sepolia demo proxies |

   The `web` service needs **no variables at all**.
5. Deploy. `web` gets a public URL; `watcher` has no port and should not be given one.

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
