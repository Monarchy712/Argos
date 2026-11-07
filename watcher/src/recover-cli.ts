/**
 * CLI for disaster recovery (watcher/src/recover.ts).
 *
 *   npm run recover -w watcher -- --report
 *       heartbeats, recovery rows, and how close each entity class is to expiry
 *
 *   npm run recover -w watcher -- --entity 0x<key> [--from-block N] [--recreate]
 *       reconstruct one entity from historical blocks; --recreate writes it back
 *
 *   npm run recover -w watcher -- --self-test
 *       create a throwaway entity with a short expiry, wait for it to expire, prove it can no
 *       longer be queried, then reconstruct it from history and compare. Touches nothing real.
 */
import { parseArgs } from "node:util";
import { createPublicClient as createArkivClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc, eq } from "@arkiv-network/sdk/query";
import { defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { http, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARKIV_BLOCK_SECONDS, BaselineSchema, ChangeNoteSchema, CurrentStateSchema, DeploymentSchema,
  DescriptorSchema, EXPIRY, LatestChangeSchema, RecoverySchema, TRUSTED_CREATORS, WatcherHealthSchema,
  describeError,
} from "@driftguard/core";
import { Heartbeat } from "./health.ts";
import { listRecoveries, reconstructEntity, recreateEntity } from "./recover.ts";
import { PUBLISHABLE_CHAINS } from "./publish.ts";

const { values } = parseArgs({
  options: {
    report: { type: "boolean", default: false },
    entity: { type: "string" },
    "from-block": { type: "string" },
    recreate: { type: "boolean", default: false },
    "self-test": { type: "boolean", default: false },
  },
});

const log = (msg: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

const env = process.env;
const chain = rabdi({ accessKey: env.ARKIV_ACCESS_KEY ?? "" });
const pub = createArkivClient({ chain, transport: http() });

/** Schemas by name, so `--entity` can recreate through the one the original carried. */
const SCHEMAS: Record<string, unknown> = {
  dg_baseline: BaselineSchema,
  dg_current_state: CurrentStateSchema,
  dg_latest_change: LatestChangeSchema,
  dg_descriptor: DescriptorSchema,
  dg_deployment: DeploymentSchema,
  dg_change_note: ChangeNoteSchema,
  dg_watcher_health: WatcherHealthSchema,
  dg_recovery: RecoverySchema,
};

/* --------------------------------------------------------------------- --report */

async function report() {
  const head = await pub.getBlockNumber();
  const days = (e: bigint) => ((Number(e - head) * ARKIV_BLOCK_SECONDS) / 86400).toFixed(1);

  console.log(`Arkiv head ${head}\n`);
  console.log("=== watcher heartbeat ===");
  const hb = new Heartbeat(log);
  for (const chainId of PUBLISHABLE_CHAINS) {
    const h = await hb.read(chainId);
    if (!h) {
      console.log(`chain ${chainId}: no heartbeat row (this build has not run yet, or the watcher key is unset)`);
      continue;
    }
    const fresh = h.ageSeconds <= EXPIRY.freshnessSeconds;
    console.log(
      `chain ${chainId}: mode=${h.mode} lastCycle=${h.ageSeconds}s ago ${fresh ? "(fresh)" : "(STALE — contracts read NOT VERIFIED)"} ` +
        `checkpoint=${h.lastScannedBlock} cycles=${h.cycles} monitored=${h.monitored} failedReads=${h.failedReads} ` +
        `startupGap=${h.startupGapBlocks} blocks downtime=${h.downtimeSeconds}s expiresIn=${h.expiresInDays.toFixed(1)}d`,
    );
  }

  console.log("\n=== retention: how close is each class to expiry? ===");
  for (const [name, schema, creator] of [
    ["dg_baseline", BaselineSchema, TRUSTED_CREATORS.writer],
    ["dg_current_state", CurrentStateSchema, TRUSTED_CREATORS.watcher],
    ["dg_latest_change", LatestChangeSchema, TRUSTED_CREATORS.watcher],
    ["dg_change_note", ChangeNoteSchema, TRUSTED_CREATORS.writer],
    ["dg_descriptor", DescriptorSchema, TRUSTED_CREATORS.writer],
    ["dg_deployment", DeploymentSchema, TRUSTED_CREATORS.writer],
    ["dg_watcher_health", WatcherHealthSchema, TRUSTED_CREATORS.watcher],
    ["dg_recovery", RecoverySchema, TRUSTED_CREATORS.writer],
  ] as const) {
    try {
      const all: bigint[] = [];
      for (let offset = 0; ; ) {
        const page = await pub.select({ $key: true, $expiresAt: true }).from(schema).createdBy(creator).orderBy(asc("$key")).limit(100).offset(offset).fetch();
        all.push(...page.entities.map((e) => e.$expiresAt));
        const covered = page.entities.length + page.skipped;
        if (covered < 100) break;
        offset += covered;
      }
      if (all.length === 0) {
        console.log(`${name.padEnd(18)} 0 rows`);
        continue;
      }
      all.sort((a, b) => (a < b ? -1 : 1));
      const threshold = head + BigInt(Math.floor(EXPIRY.renewBelowSeconds / ARKIV_BLOCK_SECONDS));
      const due = all.filter((e) => e < threshold).length;
      console.log(`${name.padEnd(18)} ${String(all.length).padStart(5)} rows   soonest ${days(all[0]!)}d   latest ${days(all[all.length - 1]!)}d   due for renewal: ${due}`);
    } catch (err) {
      console.log(`${name.padEnd(18)} read failed: ${describeError(err)}`);
    }
  }

  console.log("\n=== dg_recovery (old key → new key) ===");
  const recoveries = await listRecoveries(env);
  if (recoveries.length === 0) console.log("none: no entity has needed reconstruction");
  for (const r of recoveries) {
    console.log(`${r.status.padEnd(14)} ${r.entitySchema.padEnd(18)} ${r.oldEntityKey} → ${r.newEntityKey}`);
    console.log(`  recovered from block ${r.sourceBlock} tx ${r.sourceTx}, ${r.attributes} attributes, payload ${r.payloadHash}`);
    console.log(`  ${r.detail}`);
  }
}

/* ----------------------------------------------------------------- --self-test */

/**
 * Proves reconstruction end to end without touching a real record.
 *
 * A throwaway schema and a short expiry, so the test entity genuinely expires rather than being
 * deleted — deletion and expiry leave different traces, and it is expiry that disaster recovery
 * has to cope with. The order matters: the entity must be unqueryable *before* reconstruction is
 * attempted, otherwise the test proves nothing.
 */
const TestSchema = defineSchema("dg_recovery_selftest", {
  label: str().indexed(),
  number: u64().indexed(),
  note: str(),
});

async function selfTest() {
  const writerKey = env.ARKIV_WRITER_PRIVATE_KEY;
  if (!writerKey || !isHex(writerKey)) throw new Error("--self-test needs ARKIV_WRITER_PRIVATE_KEY");
  const wallet = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(writerKey) });

  // 1. create, with the shortest expiry the chain accepts (a multiple of the 2 s block time)
  const LIFETIME_S = 60;
  const label = `selftest-${Date.now()}`;
  const created = await wallet.executeBatch({
    creates: [
      {
        schema: TestSchema,
        values: { label, number: u64(42n), note: "payload to recover from historical blocks" },
        expiration: ExpirationTime.fromSeconds(LIFETIME_S),
      },
    ],
  });
  const entityKey = created.createdEntities[0]! as Hex;
  const createdAtBlock = await pub.getBlockNumber();
  log("self-test entity created", { entityKey, tx: created.txHash, lifetimeSeconds: LIFETIME_S, block: createdAtBlock });

  // 2. patch it, so the replay has a mutation to apply too
  const patched = await wallet.executeBatch({
    patches: [{ schema: TestSchema, entityKey, set: { note: "patched before expiry, so the replay has something to apply" } }],
  });
  log("self-test entity patched", { tx: patched.txHash });

  // 3. confirm it is live now
  const live = await pub.select().from(TestSchema).where(eq("label", label)).limit(5).fetch();
  log("queryable before expiry", { rows: live.entities.length });
  if (live.entities.length !== 1) throw new Error("the test entity should be queryable before it expires");

  // 4. wait for expiry, then confirm it is gone
  const waitMs = (LIFETIME_S + 20) * 1000;
  log("waiting for expiry", { seconds: Math.round(waitMs / 1000) });
  await new Promise((r) => setTimeout(r, waitMs));
  const gone = await pub.select().from(TestSchema).where(eq("label", label)).limit(5).fetch();
  const byKey = await pub.getEntity(entityKey).catch(() => null);
  log("after expiry", { queryRows: gone.entities.length, getEntity: byKey === null ? "null" : "still returned" });
  if (gone.entities.length !== 0) throw new Error(`the test entity is still queryable after ${LIFETIME_S}s; expiry did not take effect, so the test would prove nothing`);

  // 5. reconstruct from history and compare
  const r = await reconstructEntity(entityKey, { fromBlock: createdAtBlock - 200n, chunk: 5_000n }, { log, env });
  log("reconstructed", {
    schema: r.schemaName,
    attributes: r.attributes.length,
    patchesApplied: r.patchesApplied,
    createdBlock: r.createdBlock,
    createdTx: r.createdTx,
    payloadHash: r.payloadHash,
    history: r.history.map((h) => `${h.event}@${h.block}`).join(", "),
  });
  for (const a of r.attributes) console.log(`   ${a.name.padEnd(14)} ${a.type.padEnd(6)} ${a.indexed ? "indexed" : "       "} ${String(a.value)}`);

  const got = Object.fromEntries(r.attributes.map((a) => [a.name, a.value]));
  const checks: [string, boolean][] = [
    ["schema tag recovered", r.schemaName === "dg_recovery_selftest"],
    ["label recovered", got.label === label],
    ["u64 recovered", got.number === 42n],
    ["patch replayed (note is the patched value)", String(got.note).startsWith("patched before expiry")],
    ["create block recorded", r.createdBlock > 0n],
    ["history includes EntityCreated and EntityPatched", r.history.some((h) => h.event === "EntityCreated") && r.history.some((h) => h.event === "EntityPatched")],
  ];
  let ok = true;
  for (const [what, pass] of checks) {
    ok &&= pass;
    console.log(`${pass ? "PASS" : "FAIL"} ${what}`);
  }
  console.log(ok ? "\nSELF-TEST: PASS — an expired entity was reconstructed from historical Arkiv blocks" : "\nSELF-TEST: FAIL");
  if (!ok) process.exitCode = 1;

  // 6. recreate it, so the old → new mapping path is exercised too
  if (values.recreate) {
    const res = await recreateEntity(r, TestSchema as never, { log, env });
    console.log(`recreated as ${res.newEntityKey} (verified: ${res.verified}) — ${res.detail}`);
    console.log(`dg_recovery row: ${res.recoveryKey}`);
  } else {
    console.log("(pass --recreate as well to also write the entity back and record the old → new mapping)");
  }
}

/* --------------------------------------------------------------------- main */

if (values["self-test"]) {
  await selfTest();
} else if (values.entity) {
  const entityKey = values.entity as Hex;
  if (!isHex(entityKey) || entityKey.length !== 66) throw new Error("--entity must be a 32-byte entity key");
  const r = await reconstructEntity(
    entityKey,
    { fromBlock: values["from-block"] ? BigInt(values["from-block"]) : undefined, chunk: 10_000n },
    { log, env },
  );
  console.log(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  if (values.recreate) {
    const schema = SCHEMAS[r.schemaName];
    if (!schema) throw new Error(`no local schema named ${r.schemaName}; cannot recreate it safely`);
    const res = await recreateEntity(r, schema as never, { log, env });
    console.log(JSON.stringify(res, null, 2));
  }
} else {
  await report();
}
