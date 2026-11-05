import { readIdentity } from "@driftguard/core";
import type { PublicClient } from "viem";
import { step, shouldWrite } from "./engine.ts";
import { scanEvents, type EmitterMap, type ScannedEvent } from "./events.ts";
import type { CursorFile } from "./cursor.ts";
import type { Sink } from "./sink.ts";
import { contractId, detectionFor, type Baseline, type ChangeRecord, type CurrentState } from "./types.ts";
import type { WatcherConfig } from "./config.ts";

export interface CycleResult {
  chainId: number;
  fromBlock: bigint;
  toBlock: bigint;
  events: number;
  changes: ChangeRecord[];
  written: number;
}

export type Log = (msg: string, data?: Record<string, unknown>) => void;

/** Who emits events for this contract: the proxy itself, plus its beacon for beacon proxies. */
function emittersFor(b: Baseline, cursor: CursorFile): string[] {
  const id = contractId(b.chainId, b.address);
  const out = [b.address.toLowerCase()];
  if (b.identity.proxyKind === "beacon") {
    const beacon = (cursor.contracts[id]?.last.beacon ?? b.identity.beacon).toLowerCase();
    out.push(beacon);
  }
  return b.identity.proxyKind === "none" ? [] : out;
}

async function scanRange(
  client: PublicClient,
  emitters: EmitterMap,
  from: bigint,
  to: bigint,
  chunk: bigint,
): Promise<ScannedEvent[]> {
  const all: ScannedEvent[] = [];
  for (let start = from; start <= to; start += chunk) {
    const end = start + chunk - 1n < to ? start + chunk - 1n : to;
    all.push(...(await scanEvents(client, emitters, start, end)));
  }
  return all;
}

/**
 * One watcher cycle for one chain: scan events since the cursor, read slots at head, run the
 * engine for each monitored contract, write to the sink, and return the new cursor state.
 * The caller saves the cursor only after this resolves, so a crash re-runs the same range.
 */
export async function runChainCycle(args: {
  chainId: number;
  client: PublicClient;
  baselines: Baseline[];
  cursor: CursorFile;
  sink: Sink;
  config: WatcherConfig;
  now: number;
  log: Log;
}): Promise<CycleResult> {
  const { chainId, client, baselines, cursor, sink, config, now, log } = args;
  const latest = await client.getBlockNumber();
  const head = latest - config.confirmations;

  const minBaseline = baselines.reduce((m, b) => (b.block < m ? b.block : m), head);
  const scanned = cursor.chains[chainId] ? BigInt(cursor.chains[chainId]) : minBaseline;
  const from = scanned + 1n;

  // Map emitter address → contracts it reports for.
  const emitters: EmitterMap = new Map();
  for (const b of baselines) {
    for (const e of emittersFor(b, cursor)) {
      emitters.set(e, [...(emitters.get(e) ?? []), contractId(b.chainId, b.address)]);
    }
  }
  const events = from <= head ? await scanRange(client, emitters, from, head, config.logChunk) : [];

  // Contracts added after the chain cursor moved on: catch up from their own baseline block.
  for (const b of baselines) {
    const id = contractId(b.chainId, b.address);
    const known = cursor.contracts[id]?.baselineKey === b.key;
    if (!known && b.block < scanned) {
      const own: EmitterMap = new Map(emittersFor(b, cursor).map((e) => [e, [id]]));
      events.unshift(...(await scanRange(client, own, b.block + 1n, scanned, config.logChunk)));
    }
  }

  const changes: ChangeRecord[] = [];
  const toWrite: CurrentState[] = [];
  const latestPerContract = new Map<string, ChangeRecord>();

  for (const b of baselines) {
    const id = contractId(b.chainId, b.address);
    const mine = events.filter((e) => e.contracts.includes(id) && e.block > b.block);
    const observed = await readIdentity(client, b.address, b.identity.proxyKind, head);
    const out = step({
      chainId,
      address: b.address,
      baseline: b,
      cursor: cursor.contracts[id] ?? null,
      events: mine,
      observed,
      block: head,
      now,
    });
    for (const c of out.changes) {
      changes.push(c);
      latestPerContract.set(id, c);
      log("change", { contract: id, field: c.field, from: c.previousValue, to: c.newValue, block: c.changeBlock.toString(), by: c.detectedBy, tx: c.txHash });
    }
    if (shouldWrite(out.cursor, out.changes.length > 0, now, config.writeEveryMs)) {
      toWrite.push({
        chainId,
        address: b.address,
        identity: observed,
        identityHash: out.identityHash,
        matchesBaseline: out.matchesBaseline,
        everChangedSinceBaseline: out.cursor.everChanged,
        checkedBlock: head,
        checkedAt: Math.floor(now / 1000),
        lastScannedBlock: head,
        detection: detectionFor(b.identity.proxyKind),
        baselineKey: b.key,
      });
      out.cursor.lastWriteAt = now;
    }
    cursor.contracts[id] = out.cursor;
  }

  if (latestPerContract.size) await sink.writeLatestChanges([...latestPerContract.values()]);
  if (toWrite.length) await sink.writeCurrentStates(toWrite);
  cursor.chains[chainId] = head.toString();

  return { chainId, fromBlock: from, toBlock: head, events: events.length, changes, written: toWrite.length };
}
