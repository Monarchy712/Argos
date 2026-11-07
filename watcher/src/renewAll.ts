/**
 * The sliding-window renewal sweep: extend every Argos entity whose window is running down.
 *
 * WHY IT RUNS INSIDE THE WATCHER. `renew.ts` has always been able to do this, but only when
 * somebody ran it. An entity class that nobody remembers to renew expires, and expiry is
 * irreversible — recovery from historical blocks (recover.ts) works, but it is reconstruction,
 * not retention. So the watcher sweeps on a schedule of its own, and `renew.ts` stays for manual
 * and dry runs.
 *
 * EACH CLASS RENEWS ITSELF. Refreshing `dg_current_state` does not touch `dg_baseline`,
 * `dg_change_note` or anything else: a patch never moves an expiry, and an extension names one
 * entity. So every class is swept explicitly, by the wallet that owns it — the writer cannot
 * extend a watcher row and vice versa. A class missing from this table is a class that quietly
 * expires, which is why the list is exhaustive and the test asserts it covers every schema.
 */
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc, lt } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import { http, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARKIV_BLOCK_SECONDS,
  BaselineSchema,
  ChangeNoteSchema,
  CurrentStateSchema,
  DeploymentSchema,
  DescriptorSchema,
  EXPIRY,
  LatestChangeSchema,
  RecoverySchema,
  TRUSTED_CREATORS,
  WatcherHealthSchema,
  describeError,
} from "@driftguard/core";

/** Extensions per transaction. */
const BATCH = 50;

export type RenewRole = "writer" | "watcher";

/**
 * The schemas the sweep can query. A union rather than `unknown`: `.from()` types the whole query
 * builder, so widening the schema widens `.where()` to `never` and the expiry filter stops
 * compiling.
 */
type RenewSchema =
  | typeof BaselineSchema
  | typeof DescriptorSchema
  | typeof DeploymentSchema
  | typeof ChangeNoteSchema
  | typeof RecoverySchema
  | typeof LatestChangeSchema
  | typeof CurrentStateSchema
  | typeof WatcherHealthSchema;

/**
 * Every Argos entity class, the wallet that can extend it, and why it needs long-term
 * availability. Exhaustive on purpose; `renewAll.test.ts` fails if a schema is left out.
 */
export const RENEWAL_PLAN: { role: RenewRole; keyName: string; schemas: { name: string; schema: RenewSchema; why: string }[] }[] = [
  {
    role: "writer",
    keyName: "ARKIV_WRITER_PRIVATE_KEY",
    schemas: [
      { name: "dg_baseline", schema: BaselineSchema, why: "the trust anchor; losing it un-monitors the contract" },
      { name: "dg_descriptor", schema: DescriptorSchema, why: "the registry mirror, and the hash the browser checks a descriptor against" },
      { name: "dg_deployment", schema: DeploymentSchema, why: "binds a contract to its descriptor" },
      { name: "dg_change_note", schema: ChangeNoteSchema, why: "the 0G explanation's hash and provenance; the text on Swarm is useless without it" },
      { name: "dg_recovery", schema: RecoverySchema, why: "the old-key → new-key mapping, which is the only record that a reconstruction happened" },
    ],
  },
  {
    role: "watcher",
    keyName: "ARKIV_WATCHER_PRIVATE_KEY",
    schemas: [
      { name: "dg_latest_change", schema: LatestChangeSchema, why: "the newest detected change per contract" },
      { name: "dg_current_state", schema: CurrentStateSchema, why: "the observation trail; freshness comes from checked_at, not from expiry" },
      { name: "dg_watcher_health", schema: WatcherHealthSchema, why: "the heartbeat, which is most needed after an outage" },
    ],
  },
];

export interface RenewalSummary {
  checked: number;
  due: number;
  extended: number;
  failures: { schema: string; error: string }[];
  byClass: Record<string, { due: number; extended: number }>;
}

/**
 * One sweep. `dry` reports without writing.
 *
 * Returns rather than throws, with every failure listed: a renewal that could not be performed is
 * the thing an operator most needs to know about, and swallowing it would mean an entity expires
 * silently. The caller logs the summary; `renewalFailed` says whether to shout about it.
 */
export async function renewAll(opts: { dry?: boolean; env?: NodeJS.ProcessEnv; log: (msg: string, data?: Record<string, unknown>) => void }): Promise<RenewalSummary> {
  const env = opts.env ?? process.env;
  const { log } = opts;
  const chain = rabdi({ accessKey: env.ARKIV_ACCESS_KEY ?? "" });
  const pub = createPublicClient({ chain, transport: http() });
  const head = await pub.getBlockNumber();
  const threshold = head + BigInt(Math.floor(EXPIRY.renewBelowSeconds / ARKIV_BLOCK_SECONDS));

  const summary: RenewalSummary = { checked: 0, due: 0, extended: 0, failures: [], byClass: {} };

  for (const { role, keyName, schemas } of RENEWAL_PLAN) {
    const key = env[keyName];
    const wallet =
      key && isHex(key) ? createWalletClient({ chain, transport: http(), account: privateKeyToAccount(key) }) : null;

    for (const { name, schema } of schemas) {
      summary.byClass[name] = { due: 0, extended: 0 };
      let due: Hex[] = [];
      try {
        for (let offset = 0; ; ) {
          const page = await pub
            .select({ $key: true })
            .from(schema)
            .where(lt("$expiresAt", u64(threshold)))
            .createdBy(TRUSTED_CREATORS[role])
            .orderBy(asc("$key"))
            .limit(100)
            .offset(offset)
            .fetch();
          due.push(...page.entities.map((e) => e.$key));
          const covered = page.entities.length + page.skipped;
          if (covered < 100) break;
          offset += covered;
        }
      } catch (err) {
        summary.failures.push({ schema: name, error: `could not list expiring rows: ${describeError(err)}` });
        continue;
      }
      summary.checked++;
      summary.due += due.length;
      summary.byClass[name]!.due = due.length;
      if (due.length === 0) continue;

      if (!wallet) {
        // Rows are expiring and this process cannot extend them. Loud, not silent.
        summary.failures.push({ schema: name, error: `${due.length} row(s) expire within ${EXPIRY.renewBelowSeconds / 86400} days but ${keyName} is not set, so they cannot be renewed` });
        continue;
      }
      if (opts.dry) {
        log("would renew", { schema: name, rows: due.length });
        continue;
      }
      for (let i = 0; i < due.length; i += BATCH) {
        const group = due.slice(i, i + BATCH);
        try {
          const res = await wallet.executeBatch({ extensions: group.map((entityKey) => ({ entityKey, expiration: ExpirationTime.max() })) });
          summary.extended += res.extendedEntities.length;
          summary.byClass[name]!.extended += res.extendedEntities.length;
          log("renewed", { schema: name, rows: res.extendedEntities.length, tx: res.txHash });
        } catch (err) {
          summary.failures.push({ schema: name, error: `extension batch of ${group.length} failed: ${describeError(err)}` });
        }
      }
    }
  }
  return summary;
}

/** Whether a sweep found something an operator has to act on. */
export const renewalFailed = (s: RenewalSummary) => s.failures.length > 0 || (s.due > 0 && s.extended < s.due);
