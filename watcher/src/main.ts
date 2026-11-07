/**
 * Argos watcher: every WATCHER_POLL_MS, for each chain with baselines, scan change events
 * since the persisted cursor, read slots at head, and publish current_state / latest_change.
 *
 *   npm start -w watcher             # loop
 *   npm start -w watcher -- --once   # one cycle, then exit
 */
import { join } from "node:path";
import { clientFor, loadConfig } from "./config.ts";
import { loadCursor, saveCursor } from "./cursor.ts";
import { runChainCycle, type Log } from "./cycle.ts";
import { makeSink } from "./sinks.ts";
import { startPublishServer } from "./server.ts";
import { explainCycleChanges, explainConfigured } from "./explain.ts";
import { classifyDowntime, gapBlocks, Heartbeat } from "./health.ts";
import { renewAll, renewalFailed } from "./renewAll.ts";
import { checkDrift } from "@driftguard/importer/src/sync.ts";
import type { ArkivSink } from "./arkivSink.ts";
import { describeError } from "@driftguard/core";

/** How often the sliding renewal sweep runs. The window is months wide; hourly is ample. */
const RENEWAL_SWEEP_MS = 60 * 60 * 1000;

/**
 * How often the mirror is compared with the upstream ERC-7730 registry. The registry moves on a
 * scale of days, and the check is one `git ls-remote` plus one Arkiv read, so daily is plenty.
 */
const REGISTRY_DRIFT_MS = 24 * 60 * 60 * 1000;

const log: Log = (msg, data) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

async function main() {
  const once = process.argv.includes("--once");
  const config = loadConfig();
  const sink = await makeSink(config);
  const cursorPath = join(config.stateDir, `cursor-${sink.name}.json`);
  let stopping = false;
  const stop = () => {
    if (!stopping) log("stopping after current cycle");
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const cursor = loadCursor(cursorPath);

  // How long was this process gone, measured from the last completed cycle rather than from
  // uptime or from which entities happen to still exist? Everything that follows — the replay
  // range, the heartbeat's mode, whether an operator needs to act — comes off this one answer.
  const downtime = classifyDowntime(cursor);
  cursor.restarts = (cursor.restarts ?? 0) + 1;

  log("start", {
    sink: sink.name,
    pollMs: config.pollMs,
    writeEveryMs: config.writeEveryMs,
    resumeFrom: cursor.chains,
    restarts: cursor.restarts,
    recovery: { mode: downtime.mode, downtimeSeconds: downtime.seconds, detail: downtime.detail },
    explanations: explainConfigured() ? "enabled (0G)" : "disabled (set ZEROG_API_KEY and ARKIV_WRITER_PRIVATE_KEY)",
  });
  if (downtime.mode !== "normal") log("recovery mode", { mode: downtime.mode, downtimeSeconds: downtime.seconds, detail: downtime.detail });

  const heartbeat = new Heartbeat(log);
  if (!heartbeat.enabled) log("heartbeat disabled", { reason: "ARKIV_WATCHER_PRIVATE_KEY is not set" });
  /** Blocks each chain was behind when this process started: the gap the replay has to cover. */
  const startupGap = new Map<number, bigint>();
  const cycleCount = new Map<number, number>();
  let lastRenewalSweep = 0;
  let lastDriftCheck = 0;

  // The baseline publisher, when ARGOS_HTTP_PORT is set. It lives in this process because the
  // writer key is already here and because a new baseline starts monitoring: the loop below picks
  // it up on its next cycle with no coordination. Only the Arkiv sink can sign one.
  const http = sink.name === "arkiv" ? startPublishServer({ sink: sink as ArkivSink, clientFor, config, log }) : null;
  if (http) process.on("SIGINT", () => http.close());

  while (!stopping) {
    const started = Date.now();
    try {
      const baselines = await sink.loadBaselines();
      const chains = [...new Set(baselines.map((b) => b.chainId))];
      for (const chainId of chains) {
        // Each chain succeeds or fails on its own; a failure rolls back that chain's in-memory
        // cursor changes, so the same range is retried and no event is applied twice.
        const snapshot = structuredClone(cursor);
        try {
          const r = await runChainCycle({
            chainId,
            client: clientFor(chainId),
            baselines: baselines.filter((b) => b.chainId === chainId),
            cursor,
            sink,
            config,
            now: Date.now(),
            log,
          });
          // The checkpoint and its timestamp are saved together: the 24-hour policy is measured
          // against this, so a block checkpoint with no time beside it would be unusable.
          cursor.lastCycleAt = Date.now();
          saveCursor(cursorPath, cursor); // only after the sink accepted this cycle's writes

          if (!startupGap.has(chainId)) startupGap.set(chainId, gapBlocks(r.fromBlock - 1n, r.toBlock));
          const cycles = (cycleCount.get(chainId) ?? 0) + 1;
          cycleCount.set(chainId, cycles);

          log("cycle", {
            chainId,
            from: r.fromBlock.toString(),
            to: r.toBlock.toString(),
            blocks: (r.toBlock - r.fromBlock + 1n).toString(),
            events: r.events,
            changes: r.changes.length,
            written: r.written,
            failed: r.failed,
            ms: Date.now() - started,
          });

          // Heartbeat: the process is alive, it got this far, and this is how fresh that is.
          // Separate from every contract's current_state, and long-lived, so it can still be
          // read after an outage to say how long the outage was.
          await heartbeat.write({
            chainId,
            lastScannedBlock: r.toBlock,
            cycles,
            monitored: baselines.filter((b) => b.chainId === chainId).length,
            failedReads: r.failed,
            // Once a chain has caught up past its startup gap, it is no longer recovering.
            downtime: cycles > 1 ? { ...downtime, mode: "normal" } : downtime,
            startupGapBlocks: startupGap.get(chainId) ?? 0n,
          });

          // Explain any implementation change this cycle found. Deliberately *after* the sink
          // write and the cursor save: detection is already durable at this point, so a 0G
          // outage, a Swarm outage or a slow provider cannot delay or undo it. Awaited so the
          // logs stay in order and two cycles never generate notes concurrently; isolated inside
          // explainCycleChanges, which throws nothing.
          if (r.changes.length > 0) {
            await explainCycleChanges(r.changes, { clientFor, log });
          }
        } catch (err) {
          Object.assign(cursor, snapshot);
          log("cycle failed", { chainId, error: describeError(err) });
        }
      }
      if (chains.length === 0) log("no baselines yet; run `npm run rebaseline -w watcher`");

      // The sliding renewal sweep. Every Argos entity is created at the chain maximum (~182 days)
      // and this pushes that window out again before it runs down, for every class and by the
      // wallet that owns each one — refreshing current_state renews nothing else. Hourly: the
      // window is months wide, so the sweep is cheap and almost always finds nothing.
      if (Date.now() - lastRenewalSweep >= RENEWAL_SWEEP_MS) {
        lastRenewalSweep = Date.now();
        try {
          const s = await renewAll({ log });
          if (s.due > 0 || s.failures.length > 0) {
            log("renewal sweep", { due: s.due, extended: s.extended, byClass: s.byClass, failures: s.failures });
          }
          // A renewal that did not happen is how an entity expires silently. Never just a debug line.
          if (renewalFailed(s)) log("RENEWAL FAILURE — entities may expire", { due: s.due, extended: s.extended, failures: s.failures });
        } catch (err) {
          log("renewal sweep failed", { error: describeError(err) });
        }
      }

      // Is the ERC-7730 mirror still level with upstream? Detection only: importing a new commit
      // writes hundreds of Arkiv rows and, with --swarm, spends postage, so applying stays an
      // explicit operator action (`npm run sync -w importer -- --apply`). What this removes is the
      // need for anyone to *remember to look* — without it, drift is invisible until someone runs
      // the command by hand, which is what made the mirror a one-time import rather than a
      // synchronisation. Never throws into the cycle: an unreachable github is not a watcher fault.
      if (Date.now() - lastDriftCheck >= REGISTRY_DRIFT_MS) {
        lastDriftCheck = Date.now();
        try {
          const d = await checkDrift();
          if (d.inSync) {
            log("registry mirror in sync", { commit: d.upstream.slice(0, 7), descriptorRows: d.rows });
          } else {
            log("REGISTRY MIRROR BEHIND UPSTREAM", {
              upstream: d.upstream.slice(0, 7),
              mirror: d.mirror.slice(0, 7) || "(no rows)",
              descriptorRows: d.rows,
              action: "npm run sync -w importer -- --apply",
            });
          }
        } catch (err) {
          log("registry drift check failed", { error: describeError(err) });
        }
      }
    } catch (err) {
      // Baselines unreadable (Arkiv down or rate-limited): keep running and retry next poll.
      log("cycle failed", { error: describeError(err) });
    }
    if (once) break;
    // Sleep until the next poll, waking early on SIGINT/SIGTERM.
    const until = started + config.pollMs;
    while (!stopping && Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(250, until - Date.now())));
    }
  }
  http?.close();
  log("stopped");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
