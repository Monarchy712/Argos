/**
 * Manual sliding-window renewal: extends every Argos entity whose window is running down.
 *
 *   npm run renew -w watcher            # renews whatever this .env has keys for
 *   npm run renew -w watcher -- --dry   # report only
 *
 * The policy itself lives in renewAll.ts, which the watcher also runs hourly, so there is one
 * list of entity classes rather than two that can drift apart. This command stays because a dry
 * run is useful, and because after a long outage an operator wants to renew *now* rather than
 * wait for the next sweep.
 *
 * Writer key → dg_baseline, dg_descriptor, dg_deployment, dg_change_note, dg_recovery.
 * Watcher key → dg_latest_change, dg_current_state, dg_watcher_health.
 * A class whose key is absent is reported as a failure, not skipped silently: rows that cannot be
 * renewed are rows that will expire.
 */
import { EXPIRY } from "@driftguard/core";
import { renewAll, renewalFailed, RENEWAL_PLAN } from "./renewAll.ts";

const dry = process.argv.includes("--dry");
const log = (msg: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

console.log(
  `Renewing entities expiring within ${EXPIRY.renewBelowSeconds / 86400} days, ` +
    `back out to the chain maximum (~${Math.round(EXPIRY.maxSeconds / 86400)} days).${dry ? " DRY RUN." : ""}\n`,
);
for (const p of RENEWAL_PLAN) {
  console.log(`${p.role} (${p.keyName}): ${p.schemas.map((s) => s.name).join(", ")}`);
}
console.log();

const summary = await renewAll({ dry, log });

console.log();
for (const [name, c] of Object.entries(summary.byClass)) {
  console.log(`${name.padEnd(18)} due ${String(c.due).padStart(5)}   extended ${String(c.extended).padStart(5)}`);
}
console.log(`\ntotal: ${summary.due} due, ${summary.extended} extended across ${summary.checked} classes`);
for (const f of summary.failures) console.log(`FAILURE ${f.schema}: ${f.error}`);

// Non-zero on failure so a cron entry or a CI job notices. A renewal that silently did not happen
// is exactly how an entity expires.
if (renewalFailed(summary)) {
  console.log("\nRENEWAL FAILED — some entities may expire. See the failures above.");
  process.exitCode = 1;
} else {
  console.log(dry ? "\nDry run complete." : "\nRenewal complete.");
}
