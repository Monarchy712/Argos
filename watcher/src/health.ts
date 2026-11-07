/**
 * Watcher liveness, and the 24-hour recovery policy.
 *
 * FOUR THINGS THAT ARE NOT THE SAME. Argos used to express watcher liveness through entity
 * expiry: `dg_current_state` lived ten minutes, so a stopped watcher showed up as rows
 * disappearing. That is a correct signal and a lossy one — it conflates:
 *
 *   entity expiry        how long a record survives to be read at all
 *   watcher heartbeat    whether the process is running
 *   last scanned block   how far through the chain it has got
 *   monitoring freshness whether what it last said is recent enough to rely on
 *
 * They are now separate. Records are long-lived (EXPIRY.maxSeconds), freshness comes from
 * `checked_at` against EXPIRY.freshnessSeconds — which is what `computeStatus` already measured —
 * and this module publishes the heartbeat and the checkpoint as their own row.
 *
 * THE POLICY. On start the watcher compares the cursor's last cycle time with now:
 *
 *   normal      no gap worth mentioning. Resume from the checkpoint, replay the missed range.
 *   recovering  a gap under 24 h. Same replay, announced, and the heartbeat says so until caught up.
 *   disaster    a gap over 24 h. The missed range may be larger than event scanning can cover
 *               cheaply, and entities written before the gap may be approaching expiry, so this
 *               is reported as its own state rather than quietly replayed.
 *
 * The 24-hour line comes from the recovery guidance Arkiv gave, and it is measured from the last
 * successful cycle — a real checkpoint — not from process uptime.
 */
import { createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, eq } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import { http, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient } from "@arkiv-network/sdk";
import { ARKIV_BLOCK_SECONDS, EXPIRY, TRUSTED_CREATORS, WatcherHealthSchema, describeError } from "@driftguard/core";
import type { CursorFile } from "./cursor.ts";

/** The line the Arkiv team's recovery guidance draws. Measured from the last completed cycle. */
export const NORMAL_RECOVERY_SECONDS = 24 * 3600;
/** Below this a gap is not worth announcing: it is just the poll interval plus some slack. */
const UNREMARKABLE_GAP_SECONDS = 15 * 60;

export type WatcherMode = "normal" | "recovering" | "disaster";

export interface Downtime {
  mode: WatcherMode;
  /** Seconds since the last completed cycle, or 0 when there is no checkpoint to compare. */
  seconds: number;
  /** The block the last cycle finished at, per chain. */
  checkpoints: Record<string, string>;
  /** Human-readable, for the log line and the heartbeat row. */
  detail: string;
}

/**
 * Classifies the gap between the last completed cycle and now.
 *
 * `lastCycleAt` is written into the cursor after each successful cycle, so this is the real
 * "last successfully processed" timestamp rather than an inference from uptime or from which
 * entities happen to still exist.
 */
export function classifyDowntime(cursor: CursorFile, now = Date.now()): Downtime {
  const checkpoints = { ...cursor.chains };
  const lastCycleAt = cursor.lastCycleAt ?? 0;
  if (!lastCycleAt) {
    return {
      mode: "normal",
      seconds: 0,
      checkpoints,
      detail: Object.keys(checkpoints).length
        ? "No cycle timestamp in the cursor (written by an older build). Resuming from the block checkpoints."
        : "First run: no checkpoint to resume from, so each contract is scanned from its own baseline block.",
    };
  }
  const seconds = Math.max(0, Math.floor((now - lastCycleAt) / 1000));
  if (seconds < UNREMARKABLE_GAP_SECONDS) {
    return { mode: "normal", seconds, checkpoints, detail: `Last cycle ${seconds}s ago; resuming from the checkpoint.` };
  }
  if (seconds < NORMAL_RECOVERY_SECONDS) {
    return {
      mode: "recovering",
      seconds,
      checkpoints,
      detail:
        `The watcher was not running for ${Math.round(seconds / 60)} min. Replaying change events from the ` +
        `checkpoint so changes during the gap are detected rather than skipped. Contracts read NOT VERIFIED until ` +
        `their first fresh record lands.`,
    };
  }
  return {
    mode: "disaster",
    seconds,
    checkpoints,
    detail:
      `The watcher was not running for ${(seconds / 3600).toFixed(1)} h, past the 24-hour recovery window. ` +
      `Event replay from the checkpoint is still attempted, but the range may exceed what event scanning covers ` +
      `cheaply, and entities written before the gap may be near expiry. Run \`npm run renew -w watcher\` and ` +
      `\`npm run recover -w watcher -- --report\` before relying on anything here.`,
  };
}

/** Blocks between the checkpoint and head: what the replay has to cover. */
export const gapBlocks = (checkpoint: bigint | undefined, head: bigint): bigint =>
  checkpoint === undefined || checkpoint >= head ? 0n : head - checkpoint;

export interface HeartbeatInput {
  chainId: number;
  lastScannedBlock: bigint;
  cycles: number;
  monitored: number;
  failedReads: number;
  downtime: Downtime;
  startupGapBlocks: bigint;
}

/**
 * Publishes (or refreshes) this chain's heartbeat row.
 *
 * Long-lived and renewed on a sliding window like everything else, because a heartbeat is most
 * useful *after* an outage — the row that says "the last cycle was 30 hours ago" has to still be
 * there to say it. Never throws: a heartbeat that cannot be written must not take down the cycle
 * that produced it.
 */
export class Heartbeat {
  private readonly pub = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });
  private readonly wallet: ReturnType<typeof createWalletClient> | null;
  /** chainId → entity key + expiry, so a refresh patches instead of creating a second row. */
  private rows = new Map<number, { key: Hex; expiresAt: bigint }>();
  private loaded = false;

  private readonly log: (msg: string, data?: Record<string, unknown>) => void;

  constructor(log: (msg: string, data?: Record<string, unknown>) => void, env = process.env) {
    this.log = log;
    const k = env.ARKIV_WATCHER_PRIVATE_KEY;
    this.wallet =
      k && isHex(k)
        ? createWalletClient({ chain: rabdi({ accessKey: env.ARKIV_ACCESS_KEY ?? "" }), transport: http(), account: privateKeyToAccount(k) })
        : null;
  }

  get enabled() {
    return this.wallet !== null;
  }

  private async load(): Promise<void> {
    const page = await this.pub
      .select({ $key: true, $expiresAt: true, chain_id: true })
      .from(WatcherHealthSchema)
      .createdBy(TRUSTED_CREATORS.watcher)
      .orderBy(asc("$key"))
      .limit(100)
      .fetch();
    this.rows = new Map(page.entities.map((r) => [Number(r.chain_id.value), { key: r.$key, expiresAt: r.$expiresAt }]));
    this.loaded = true;
  }

  async write(input: HeartbeatInput): Promise<void> {
    if (!this.wallet) return;
    try {
      if (!this.loaded) await this.load();
      const values = {
        chain_id: u64(BigInt(input.chainId)),
        last_scanned_block: u64(input.lastScannedBlock),
        last_cycle_at: u64(BigInt(Math.floor(Date.now() / 1000))),
        cycles: u64(BigInt(input.cycles)),
        startup_gap_blocks: u64(input.startupGapBlocks),
        downtime_seconds: u64(BigInt(input.downtime.seconds)),
        mode: input.downtime.mode,
        monitored: u64(BigInt(input.monitored)),
        failed_reads: u64(BigInt(input.failedReads)),
      };
      const existing = this.rows.get(input.chainId);
      const head = await this.pub.getBlockNumber();
      const renewDue = existing && existing.expiresAt - head < BigInt(Math.floor(EXPIRY.renewBelowSeconds / ARKIV_BLOCK_SECONDS));
      if (existing) {
        const res = await this.wallet.executeBatch({
          patches: [{ schema: WatcherHealthSchema, entityKey: existing.key, set: values }],
          ...(renewDue ? { extensions: [{ entityKey: existing.key, expiration: ExpirationTime.max() }] } : {}),
        });
        if (renewDue) this.log("heartbeat renewed", { chainId: input.chainId, tx: res.txHash });
      } else {
        const res = await this.wallet.executeBatch({
          creates: [{ schema: WatcherHealthSchema, values, expiration: ExpirationTime.max() }],
        });
        this.rows.set(input.chainId, { key: res.createdEntities[0]! as Hex, expiresAt: head + 7_884_000n });
      }
    } catch (err) {
      // A heartbeat is a report about the cycle, not part of it. Losing one is visible (the row
      // goes stale) and must not fail the cycle that already did the work.
      this.log("heartbeat write failed", { chainId: input.chainId, error: describeError(err) });
      this.loaded = false; // re-read keys next time: the row may have been replaced
    }
  }

  /** The heartbeat for one chain, for `--report` and for tests. */
  async read(chainId: number) {
    const page = await this.pub
      .select()
      .from(WatcherHealthSchema)
      .where(and(eq("chain_id", u64(BigInt(chainId)))))
      .createdBy(TRUSTED_CREATORS.watcher)
      .limit(5)
      .fetch();
    const r = page.entities[0];
    if (!r) return null;
    const now = Math.floor(Date.now() / 1000);
    return {
      key: r.$key,
      chainId,
      lastScannedBlock: r.last_scanned_block.value,
      lastCycleAt: Number(r.last_cycle_at.value),
      ageSeconds: now - Number(r.last_cycle_at.value),
      cycles: Number(r.cycles.value),
      mode: r.mode.value as WatcherMode,
      downtimeSeconds: Number(r.downtime_seconds.value),
      startupGapBlocks: r.startup_gap_blocks.value,
      monitored: Number(r.monitored.value),
      failedReads: Number(r.failed_reads.value),
      expiresInDays: (Number(r.$expiresAt - page.blockNumber) * ARKIV_BLOCK_SECONDS) / 86400,
    };
  }
}
