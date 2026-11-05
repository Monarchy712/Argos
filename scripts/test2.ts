/**
 * Test 2 (Arkiv records) — run: node --env-file=.env scripts/test2.ts
 *
 * Creates baseline (writer wallet) + current_state and latest_change (watcher wallet), queries
 * them back by $creator, updates current_state/latest_change in ONE executeBatch (patch +
 * extend), confirms the baseline is untouched, renews the baseline, and waits for a 2-minute
 * current_state to expire so a reader falls back to NOT VERIFIED. Prints timings and any 429s.
 *
 * Test rows use chain_id 31337 and a random address, so they can't be mistaken for real ones,
 * and are deleted at the end (the lapse row expires by itself).
 */
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, eq } from "@arkiv-network/sdk/query";
import { addr, u64 } from "@arkiv-network/sdk/schema";
import { http, isHex, zeroAddress, zeroHash, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { BaselineSchema, CurrentStateSchema, LatestChangeSchema } from "@driftguard/core";

const env = process.env;
for (const k of ["ARKIV_WRITER_PRIVATE_KEY", "ARKIV_WATCHER_PRIVATE_KEY"]) {
  if (!env[k] || !isHex(env[k])) throw new Error(`set ${k} in .env`);
}
const chain = rabdi({ accessKey: env.ARKIV_ACCESS_KEY ?? "" });
const writer = privateKeyToAccount(env.ARKIV_WRITER_PRIVATE_KEY as Hex);
const watcher = privateKeyToAccount(env.ARKIV_WATCHER_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain, transport: http() });
const writerClient = createWalletClient({ chain, transport: http(), account: writer });
const watcherClient = createWalletClient({ chain, transport: http(), account: watcher });

// --- timing + 429 bookkeeping -------------------------------------------------------------
const timings: Record<string, number[]> = {};
let rateLimited = 0;
/** HTTP status anywhere in a viem error's cause chain. */
function statusOf(err: unknown): number | undefined {
  for (let c = err as { status?: number; cause?: unknown } | undefined; c; c = c.cause as typeof c) {
    if (typeof c.status === "number") return c.status;
  }
  return undefined;
}
/** Rate-limit details (body + ratelimit header) from a 429, for the report. */
function rateLimitInfo(err: unknown): string {
  for (let c = err as { details?: string; headers?: Headers; cause?: unknown } | undefined; c; c = c.cause as typeof c) {
    if (c.headers) return `${c.details ?? ""} ratelimit="${c.headers.get("ratelimit")}" retry-after=${c.headers.get("retry-after")}`;
  }
  return String(err).slice(0, 120);
}
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } catch (err) {
    if (statusOf(err) === 429) rateLimited++;
    throw err;
  } finally {
    (timings[label] ??= []).push(Math.round(performance.now() - t0));
  }
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${note ? ` — ${note}` : ""}`);
};

// --- preflight ------------------------------------------------------------------------------
const [wBal, sBal] = await Promise.all([pub.getBalance({ address: writer.address }), pub.getBalance({ address: watcher.address })]);
console.log(`writer ${writer.address} balance ${wBal} wei; watcher ${watcher.address} balance ${sBal} wei`);
if (wBal === 0n || sBal === 0n) {
  console.log("BLOCKED: fund both wallets at https://hub.arkiv.network/faucet");
  process.exit(3);
}

const CHAIN = 31337n;
const ADDRESS = privateKeyToAccount(generatePrivateKey()).address; // fresh, unique per run
const IMPL_A = privateKeyToAccount(generatePrivateKey()).address;
const IMPL_B = privateKeyToAccount(generatePrivateKey()).address;
const identityA = "0x" + "a1".repeat(32);
const identityB = "0x" + "b2".repeat(32);
const now = () => u64(BigInt(Math.floor(Date.now() / 1000)));
const ident = (impl: string, code: string) => ({
  proxy_kind: "eip1967",
  implementation: addr(impl),
  implementation_codehash: zeroHash as string,
  admin: addr(zeroAddress),
  beacon: addr(zeroAddress),
  facets_hash: zeroHash as string,
  code_identity: code,
});
const where = and(eq("chain_id", u64(CHAIN)), eq("address", addr(ADDRESS)));

// --- 1. create ------------------------------------------------------------------------------
const baseline = await timed("create", () =>
  writerClient.createEntity(
    BaselineSchema,
    {
      chain_id: u64(CHAIN),
      address: addr(ADDRESS),
      ...ident(IMPL_A, identityA),
      descriptor_hash: "",
      swarm_ref: "",
      baseline_block: u64(100n),
      baselined_at: now(),
      rebaseline_reason: "test2",
      previous_baseline_key: "",
    },
    { expiration: ExpirationTime.max() },
  ),
);
const stateValues = (impl: string, code: string, block: bigint, matches: boolean, ever: boolean) => ({
  chain_id: u64(CHAIN),
  address: addr(ADDRESS),
  ...ident(impl, code),
  matches_baseline: matches,
  ever_changed_since_baseline: ever,
  checked_block: u64(block),
  checked_at: now(),
  last_scanned_block: u64(block),
  detection: "event+slot",
  baseline_key: baseline.entityKey as string,
});
const live = await timed("create", () =>
  watcherClient.createEntity(CurrentStateSchema, stateValues(IMPL_A, identityA, 101n, true, false), {
    expiration: ExpirationTime.fromMinutes(10),
  }),
);
const lapse = await timed("create", () =>
  watcherClient.createEntity(
    CurrentStateSchema,
    { ...stateValues(IMPL_A, identityA, 101n, true, false), detection: "lapse-test" },
    { expiration: ExpirationTime.fromMinutes(2) },
  ),
);
const change = await timed("create", () =>
  watcherClient.createEntity(
    LatestChangeSchema,
    {
      chain_id: u64(CHAIN),
      address: addr(ADDRESS),
      field: "implementation",
      previous_value: IMPL_A.toLowerCase(),
      new_value: IMPL_B.toLowerCase(),
      change_block: u64(102n),
      tx_hash: "0x" + "11".repeat(32),
      detected_at: now(),
      detected_by: "event",
    },
    { expiration: ExpirationTime.max() },
  ),
);
check("create baseline / 2× current_state / latest_change", true, `keys ${baseline.entityKey.slice(0, 10)}…`);

// --- 2. query back, trusting only the right creator ------------------------------------------
const readBaseline = () =>
  timed("query", () => pub.select().from(BaselineSchema).where(where).createdBy(writer.address).fetch());
const b0 = await readBaseline();
check("baseline readable by $creator=writer", b0.entities.length === 1 && b0.entities[0]!.implementation.value === IMPL_A);
const forged = await timed("query", () => pub.select({ $key: true }).from(BaselineSchema).where(where).createdBy(watcher.address).fetch());
check("same query with $creator=watcher returns nothing (creator filter works)", forged.entities.length === 0);
const states = await timed("query", () => pub.select().from(CurrentStateSchema).where(where).createdBy(watcher.address).fetch());
check("current_state rows readable by $creator=watcher", states.entities.length === 2);

// --- 3. update current_state + latest_change in one batch (patch + extend) ------------------
const before = states.entities.find((e) => e.$key === live.entityKey)!;
const batch = await timed("batch", () =>
  watcherClient.executeBatch({
    patches: [
      {
        schema: CurrentStateSchema,
        entityKey: live.entityKey,
        set: { implementation: addr(IMPL_B), code_identity: identityB, matches_baseline: false, ever_changed_since_baseline: true, checked_block: u64(103n), checked_at: now() },
      },
      { schema: LatestChangeSchema, entityKey: change.entityKey, set: { new_value: IMPL_A.toLowerCase(), previous_value: IMPL_B.toLowerCase(), change_block: u64(104n) } },
    ],
    extensions: [{ entityKey: live.entityKey, expiration: ExpirationTime.fromMinutes(10) }],
  }),
);
const after = (await timed("query", () => pub.select().from(CurrentStateSchema).where(where).createdBy(watcher.address).fetch())).entities.find(
  (e) => e.$key === live.entityKey,
)!;
check(
  "executeBatch patched + extended current_state in one tx",
  after.implementation.value === IMPL_B && after.ever_changed_since_baseline.value === true && after.$expiresAt > before.$expiresAt,
  `tx ${batch.txHash.slice(0, 10)}…, expiresAt ${before.$expiresAt}→${after.$expiresAt}`,
);
const lc = await timed("query", () => pub.select().from(LatestChangeSchema).where(where).createdBy(watcher.address).fetch());
check("latest_change replaced in place (same key, new value)", lc.entities.length === 1 && lc.entities[0]!.new_value.value === IMPL_A.toLowerCase());

// --- 4. baseline untouched ------------------------------------------------------------------
const b1 = await readBaseline();
check(
  "baseline unchanged after state updates",
  JSON.stringify(b1.entities[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ===
    JSON.stringify(b0.entities[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
);

// --- 5. renewal ------------------------------------------------------------------------------
await new Promise((r) => setTimeout(r, 4000)); // a couple of blocks, so max() lands later
const ext = await timed("extend", () => writerClient.extendEntity({ entityKey: baseline.entityKey, expiration: ExpirationTime.max() }));
const b2 = await readBaseline();
check("renewal: extendEntity moved baseline $expiresAt later", b2.entities[0]!.$expiresAt > b0.entities[0]!.$expiresAt, `${b0.entities[0]!.$expiresAt}→${b2.entities[0]!.$expiresAt} (tx ${ext.txHash.slice(0, 10)}…)`);

// --- 6. short-expiry current_state lapses → NOT VERIFIED -------------------------------------
const status = (rows: unknown[]) => (rows.length === 0 ? "NOT VERIFIED (no live watcher record)" : "has watcher record");
const lapseWhere = and(eq("chain_id", u64(CHAIN)), eq("address", addr(ADDRESS)));
console.log("waiting for the 2-minute current_state to expire…");
const t0 = Date.now();
let gone = false;
while (Date.now() - t0 < 4 * 60_000) {
  const rows = (await timed("query", () => pub.select({ $key: true, detection: true }).from(CurrentStateSchema).where(lapseWhere).createdBy(watcher.address).fetch())).entities;
  if (!rows.some((r) => r.$key === lapse.entityKey)) {
    gone = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 20_000)); // sparse polling: keyless reads have a cost budget
}
const remaining = (await pub.select({ $key: true }).from(CurrentStateSchema).where(lapseWhere).createdBy(watcher.address).fetch()).entities.filter((r) => r.$key === lapse.entityKey);
check("2-minute current_state expired and disappeared from queries", gone, `after ~${Math.round((Date.now() - t0) / 1000)} s; reader status: ${status(remaining)}`);

// --- 7. keyless read latency (what the browser does) -----------------------------------------
// No retries, so a 429 is observed instead of being backed off and hidden. The public endpoint
// gives each anonymous client a cost budget (429 ANON_COST_LIMITED when spent).
const keyless = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http(undefined, { retryCount: 0, timeout: 15_000 }) });
let keylessOk = 0;
for (let i = 0; i < 20; i++) {
  try {
    await timed("keyless query", () => keyless.select({ $key: true }).from(BaselineSchema).createdBy(writer.address).limit(100).fetch());
    keylessOk++;
  } catch (err) {
    console.log(`keyless query ${i + 1}/20 refused: HTTP ${statusOf(err)} ${rateLimitInfo(err)}`);
    break;
  }
}
console.log(`keyless reads: ${keylessOk}/20 answered${env.ARKIV_ACCESS_KEY ? "" : " (all other reads in this run were keyless too)"}`);

// --- cleanup -------------------------------------------------------------------------------
await timed("batch", () => watcherClient.executeBatch({ deletes: [{ entityKey: live.entityKey }, { entityKey: change.entityKey }] }));
await timed("delete", () => writerClient.deleteEntity({ entityKey: baseline.entityKey }));

// --- summary -------------------------------------------------------------------------------
console.log("\n== timings (ms)");
for (const [label, xs] of Object.entries(timings)) {
  console.log(`${label.padEnd(14)} n=${String(xs.length).padStart(2)} p50=${pct(xs, 50)} p95=${pct(xs, 95)} max=${Math.max(...xs)}`);
}
console.log(`429 responses: ${rateLimited}`);
const ok = results.every(([, pass]) => pass);
console.log(ok ? "TEST 2: PASS" : "TEST 2: FAIL");
process.exitCode = ok ? 0 : 1; // natural exit: process.exit() trips a libuv assert on Windows
