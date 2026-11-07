/**
 * Build-time configuration, readable from a unit test.
 *
 * WHY THIS EXISTS. Vite replaces `import.meta.env` when it bundles, so a module that reads it
 * directly throws `Cannot read properties of undefined` the moment `node --test` imports it —
 * `paging.ts` already carries a comment about being kept free of Vite-only imports for exactly
 * that reason. Reading it through here means a module can be unit-tested without the Vite
 * pipeline, and no call site has to repeat the fallback.
 *
 * WHY THE ALLOW-LIST. Referencing `import.meta.env` as an object (rather than a literal
 * `import.meta.env.VITE_FOO`, which Vite substitutes one variable at a time) makes Vite emit the
 * whole object into the bundle. That would mean every `VITE_*` variable present on the build
 * machine ships, including one this app never reads. `KNOWN` is therefore the complete set of
 * variables the app may see; anything else is dropped here and cannot ride along by accident.
 *
 * NO SECRETS. Every `VITE_*` value is inlined into the published bundle by definition — that is
 * what `VITE_` means — so none of these is a secret. The publish token among them gates casual use
 * of the publisher endpoint and is not the authorisation boundary (see lib/publish.ts); the access
 * key raises a read rate limit. ARKIV_WRITER_PRIVATE_KEY, ARKIV_WATCHER_PRIVATE_KEY and
 * ZEROG_API_KEY are never `VITE_*` and never reach the browser: the server signs, the browser asks.
 */

/** Every build-time variable this app is allowed to read. Keep in step with web/.env.example. */
const KNOWN = [
  "BASE_URL",
  "VITE_ARGOS_API_URL",
  "VITE_ARGOS_PUBLISH_TOKEN",
  "VITE_ARKIV_ACCESS_KEY",
  "VITE_MAINNET_RPC_URL",
  "VITE_SEPOLIA_RPC_URL",
  "VITE_SWARM_GATEWAY",
] as const;

type Known = (typeof KNOWN)[number];

const RAW: Record<string, string | undefined> =
  (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string | undefined> }).env) || {};

const VALUES: Partial<Record<Known, string>> = {};
for (const name of KNOWN) {
  const v = RAW[name];
  if (typeof v === "string" && v.length > 0) VALUES[name] = v;
}

/** A build-time value, or undefined when this build did not set one. */
export const viteEnv = (name: Known): string | undefined => VALUES[name];

/** Same, with a default — the common case, since every value the app reads has a fallback. */
export const viteEnvOr = (name: Known, fallback: string): string => VALUES[name] ?? fallback;
