/**
 * Pure detection logic: given what we knew, the events since then and a fresh slot read,
 * decide which changes happened and what the contract's state is now. No I/O here, so the
 * A→B→A and restart cases are unit-tested directly.
 */
import { codeIdentityHash, diffIdentity, fieldValue, type ChangeField, type CodeIdentity } from "@driftguard/core";
import { getAddress, type Address, type Hex } from "viem";
import type { Baseline, ChangeRecord, ContractCursor, ObservedEvent } from "./types.ts";

export interface StepInput {
  chainId: number;
  address: Address;
  baseline: Baseline;
  /** null on the first cycle for this contract (or after a rebaseline). */
  cursor: ContractCursor | null;
  /** Events for this contract in block/log order, since the last scanned block. */
  events: ObservedEvent[];
  /** Slot read at `block`. */
  observed: CodeIdentity;
  block: bigint;
  now: number;
}

export interface StepOutput {
  cursor: ContractCursor;
  changes: ChangeRecord[];
  identityHash: Hex;
  matchesBaseline: boolean;
}

/** Applies an event's new value to an identity (only fields an event can carry). */
function withField(id: CodeIdentity, field: ChangeField, value: string): CodeIdentity {
  switch (field) {
    case "implementation":
      return { ...id, implementation: getAddress(value) };
    case "admin":
      return { ...id, admin: getAddress(value) };
    case "beacon":
      return { ...id, beacon: getAddress(value) };
    default:
      return id;
  }
}

export function step(input: StepInput): StepOutput {
  const { chainId, address, baseline, events, observed, block, now } = input;

  // A new baseline (first run, or `rebaseline`) resets memory, including ever_changed.
  const fresh = !input.cursor || input.cursor.baselineKey !== baseline.key;
  let last: CodeIdentity = fresh ? baseline.identity : input.cursor!.last;
  let everChanged = fresh ? false : input.cursor!.everChanged;

  const changes: ChangeRecord[] = [];
  const explained = new Set<ChangeField>();

  // 1. Events, in order. Each one that moves a field away from what we last knew is a change.
  for (const ev of events) {
    const previous = fieldValue(last, ev.field);
    const next = ev.newValue ?? `${ev.field}-changed@${ev.txHash}`;
    if (ev.newValue !== null && next === previous) continue; // no-op upgrade to the same value
    changes.push({
      chainId,
      address,
      field: ev.field,
      previousValue: previous,
      newValue: next,
      changeBlock: ev.block,
      txHash: ev.txHash,
      detectedAt: now,
      detectedBy: "event",
    });
    explained.add(ev.field);
    if (ev.newValue === null || next !== fieldValue(baseline.identity, ev.field)) everChanged = true;
    if (ev.newValue !== null) last = withField(last, ev.field, ev.newValue);
  }
  // An implementation change explains its codehash change; a diamond cut explains facets.
  if (explained.has("implementation")) explained.add("codehash");

  // 2. Slot read. Anything that still differs from what we knew, without an event, is a
  //    slot-detected change (poll-only proxies, or events we missed).
  const slotDiff = diffIdentity(last, observed);
  // A new implementation implies a new codehash; report the implementation change only.
  if (slotDiff.includes("implementation")) explained.add("codehash");
  for (const field of slotDiff) {
    if (explained.has(field)) continue;
    changes.push({
      chainId,
      address,
      field,
      previousValue: fieldValue(last, field),
      newValue: fieldValue(observed, field),
      changeBlock: block,
      txHash: "",
      detectedAt: now,
      detectedBy: "slot",
    });
  }

  const identityHash = codeIdentityHash(observed);
  const matchesBaseline = identityHash === baseline.identityHash;
  // Sticky: once true, only a rebaseline clears it (A→B→A stays true).
  if (!matchesBaseline) everChanged = true;

  return {
    cursor: {
      baselineKey: baseline.key,
      last: observed,
      everChanged,
      lastWriteAt: fresh ? 0 : input.cursor!.lastWriteAt,
    },
    changes,
    identityHash,
    matchesBaseline,
  };
}

/** Whether this cycle should write current_state: on any change, or when the write is due. */
export function shouldWrite(cursor: ContractCursor, changed: boolean, now: number, writeEveryMs: number): boolean {
  return changed || now - cursor.lastWriteAt >= writeEveryMs;
}
