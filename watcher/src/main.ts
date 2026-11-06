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
import { describeError } from "@driftguard/core";

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
  log("start", { sink: sink.name, pollMs: config.pollMs, writeEveryMs: config.writeEveryMs, resumeFrom: cursor.chains });

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
          saveCursor(cursorPath, cursor); // only after the sink accepted this cycle's writes
          log("cycle", {
            chainId,
            from: r.fromBlock.toString(),
            to: r.toBlock.toString(),
            events: r.events,
            changes: r.changes.length,
            written: r.written,
            failed: r.failed,
            ms: Date.now() - started,
          });
        } catch (err) {
          Object.assign(cursor, snapshot);
          log("cycle failed", { chainId, error: describeError(err) });
        }
      }
      if (chains.length === 0) log("no baselines yet; run `npm run rebaseline -w watcher`");
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
  log("stopped");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
