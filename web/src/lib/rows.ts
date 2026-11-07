/**
 * The shared contract model: one Arkiv snapshot turned into the rows every screen renders.
 *
 * Lifted out of the old Monitored screen so the overview, the contracts table and the contract
 * workspace all read the same shape and compute status in exactly one place (@driftguard/core's
 * computeStatus). Nothing here invents data: every field comes from a row the watcher or the
 * writer published, or is derived from the registry manifest that ships with the app.
 */
import { useCallback, useEffect, useState } from "react";
import { computeStatus, PROXY_KINDS, type Status, type StatusResult } from "@driftguard/core";
import {
  readArkiv, idOf, ArkivRateLimitedError,
  type ArkivSnapshot, type BaselineRow, type ChangeRow, type ChangeNoteRow, type CurrentRow,
} from "./arkiv.ts";
import { ARKIV_REFRESH_MS, GUARD_DEMO, demoContractInfo } from "./config.ts";
import { descriptorFor, loadManifest, type RegistryManifest } from "./descriptors.ts";
import { localStatus, type LiveCheck } from "./watchlist.ts";
import type { PendingBaseline } from "./pending.ts";

export interface MonitoredRow {
  id: string;
  chainId: number;
  address: string;
  protocol: string;
  attested: boolean;
  proxyKind: string;
  detection: string;
  baseline: BaselineRow;
  current: CurrentRow | null;
  change: ChangeRow | null;
  changeNote: ChangeNoteRow | null;
  descriptorHash: string | null;
  descriptorPath: string | null;
  status: StatusResult;
  /** true for the two Sepolia proxies Argos deploys itself, so demos never read as live protocol data */
  isDemo: boolean;
  /** only the guard-demo proxy exposes the getter ArgosGuard needs */
  guardable: boolean;
  /**
   * Where the baseline and the observation came from. Never blended in the UI:
   *   arkiv — published by the Argos writer, observed continuously by the watcher.
   *   local — recorded in this browser, observed by this browser while the page is open.
   */
  source: "arkiv" | "local";
}

const ORDER: Record<Status, number> = { RED: 0, NOT_VERIFIED: 1, GREEN: 2 };

const detectionFor = (kind: string) =>
  kind === "safe" || kind === "none" ? "slot-only"
  : (PROXY_KINDS as readonly string[]).includes(kind) ? "event+slot"
  : "unsupported";

/**
 * Index rows by contract, keeping the newest when a contract has more than one.
 *
 * `new Map(rows.map(...))` keeps whichever row happens to arrive last, and Arkiv pages are ordered
 * by `$key` — an address-derived hash with no relation to time. One contract on Sepolia really did
 * end up with two `dg_current_state` rows (two watcher processes ran briefly at once), and the
 * older of them still asserted `matches_baseline: true` for an implementation that had since
 * changed. Which one the UI rendered was down to how the two keys happened to sort.
 *
 * This is only a tie-break, not a repair: duplicates are still a watcher-side problem. But the row
 * a reader sees must be the most recent observation, not an arbitrary one.
 */
function newestBy<T extends { chainId: number; address: string }>(rows: readonly T[], at: (r: T) => number): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) {
    const id = idOf(r.chainId, r.address);
    const kept = m.get(id);
    if (!kept || at(r) > at(kept)) m.set(id, r);
  }
  return m;
}

export function buildRows(snap: ArkivSnapshot, manifest: RegistryManifest | null, now: number): MonitoredRow[] {
  const cur = newestBy(snap.current, (c) => c.checkedAt);
  const chg = newestBy(snap.changes, (c) => Number(c.changeBlock));
  // A contract accumulates one note per change, so group them and pick per contract below: the
  // note shown beside a change must be the note *for that change*, not the latest one it has.
  const notesFor = new Map<string, ChangeNoteRow[]>();
  for (const n of snap.changeNotes) {
    const id = idOf(n.chainId, n.address);
    notesFor.set(id, [...(notesFor.get(id) ?? []), n]);
  }

  return snap.baselines
    .map((b) => {
      const id = idOf(b.chainId, b.address);
      const current = cur.get(id) ?? null;
      const change = chg.get(id) ?? null;
      const mine = notesFor.get(id) ?? [];
      const changeNote =
        (change && mine.find((n) => n.changeBlock === change.changeBlock)) ??
        mine.reduce<ChangeNoteRow | null>((best, n) => (!best || n.changeBlock > best.changeBlock ? n : best), null);
      const desc = manifest ? descriptorFor(manifest, b.chainId, b.address) : null;
      const isGuardDemo = id === idOf(GUARD_DEMO.chainId, GUARD_DEMO.proxy);
      const demo = demoContractInfo(b.chainId, b.address);
      const supported = (PROXY_KINDS as readonly string[]).includes(b.proxyKind);

      const status = computeStatus({
        now,
        monitored: true,
        supported,
        baseline: { codeIdentity: b.codeIdentity, block: b.block },
        current: current && {
          codeIdentity: current.codeIdentity,
          matchesBaseline: current.matchesBaseline,
          everChangedSinceBaseline: current.everChanged,
          checkedBlock: current.checkedBlock,
          checkedAt: current.checkedAt,
          expiresAt: current.expiresAt,
        },
        latestChange: change && { field: change.field, changeBlock: change.changeBlock, txHash: change.txHash },
        live: { state: "not-run" },
      });

      return {
        id,
        chainId: b.chainId,
        address: b.address,
        protocol: demo ? demo.label : desc ? desc.owner || desc.entity : "—",
        attested: !!desc?.attested,
        proxyKind: b.proxyKind,
        detection: current?.detection || detectionFor(b.proxyKind),
        baseline: b,
        current,
        change,
        changeNote,
        descriptorHash: b.descriptorHash || desc?.descriptorHash || null,
        descriptorPath: desc?.path ?? null,
        status,
        isDemo: demo !== null,
        guardable: isGuardDemo,
        source: "arkiv" as const,
      };
    })
    .sort(byStatus);
}

/** Changed first, then not verified, then matching; alphabetical within each. */
export const byStatus = (a: MonitoredRow, b: MonitoredRow) =>
  ORDER[a.status.status] - ORDER[b.status.status] || a.protocol.localeCompare(b.protocol);

/**
 * The Argos network: registry contracts the watcher monitors, i.e. everything except the proxies
 * this deployment's operator deployed. Those are listed under Yours (see `demoRows`), and a
 * contract is never in both lists.
 */
export const userRows = (rows: MonitoredRow[]) => rows.filter((r) => !r.isDemo);

/** The proxies this deployment's operator deployed and upgrades; shown under Yours. */
export const demoRows = (rows: MonitoredRow[]) => rows.filter((r) => r.isDemo);

/**
 * Your own contracts, in the same shape as the Arkiv-monitored ones, so one table and one
 * workspace serve both. The Arkiv-specific fields that genuinely do not exist for a local
 * baseline (entity keys, Swarm refs, watcher expiry) are empty rather than invented, and the
 * Evidence tab reads `source` to say so instead of showing blanks.
 */
export function buildLocalRows(entries: PendingBaseline[], checks: Record<string, LiveCheck>, now: number): MonitoredRow[] {
  void now;
  return entries
    .map((e) => {
      const id = idOf(e.chainId, e.address);
      const live = checks[id] ?? { state: "pending" as const };
      const status = localStatus(e, live);
      const ok = live.state === "ok";

      const baseline: BaselineRow = {
        key: "" as `0x${string}`,
        chainId: e.chainId,
        address: e.address as BaselineRow["address"],
        proxyKind: e.proxyKind,
        implementation: e.implementation as BaselineRow["implementation"],
        codeIdentity: e.codeIdentity as `0x${string}`,
        descriptorHash: e.descriptorHash ?? "",
        swarmRef: "",
        block: BigInt(e.observedBlock),
        baselinedAt: e.observedAt,
        reason: "baseline you set in this browser",
      };

      const current: CurrentRow | null = ok
        ? {
            key: "" as `0x${string}`,
            chainId: e.chainId,
            address: e.address as CurrentRow["address"],
            implementation: live.implementation,
            codeIdentity: live.codeIdentity,
            matchesBaseline: live.codeIdentity.toLowerCase() === e.codeIdentity.toLowerCase(),
            everChanged: false,
            checkedBlock: live.block,
            checkedAt: live.at,
            detection: "your live read",
            expiresAt: Number.MAX_SAFE_INTEGER,
          }
        : null;

      return {
        id,
        chainId: e.chainId,
        address: e.address,
        protocol: e.label,
        attested: false,
        proxyKind: e.proxyKind,
        detection: "your live read",
        baseline,
        current,
        change: null,
        changeNote: null,
        descriptorHash: e.descriptorHash,
        descriptorPath: e.descriptorPath,
        status,
        isDemo: false,
        guardable: false,
        source: "local" as const,
      } satisfies MonitoredRow;
    })
    .sort(byStatus);
}

export const findRow = (rows: MonitoredRow[], chainId: number, address: string) =>
  rows.find((r) => r.id === idOf(chainId, address)) ?? null;

/* ------------------------------------------------------------------ events
   Arkiv keeps the baseline and the *latest* change per contract (dg_latest_change), not a full
   per-contract log, so this timeline shows exactly those records and nothing is interpolated
   between them. Monitoring gaps are derived from the current_state row's own freshness. */

export type EventKind = "baseline" | "change" | "explanation" | "monitoring" | "descriptor";

export interface ContractEvent {
  /** stable across reloads, so a URL can deep-link to one event */
  id: string;
  kind: EventKind;
  title: string;
  detail: string;
  /** unix seconds; null when the record carries no timestamp */
  at: number | null;
  block: bigint | null;
  txHash: string | null;
  tone: "ok" | "bad" | "warn" | "info" | "neutral";
  /** change events open the Investigate tab */
  investigable: boolean;
}

export function contractEvents(r: MonitoredRow, now: number): ContractEvent[] {
  const out: ContractEvent[] = [];

  if (r.change) {
    // A change recorded before the current baseline block was superseded by a rebaseline. It is
    // history, not an open finding, and must not be coloured or worded as one — the contract's
    // badge may well read VERIFIED.
    const superseded = r.change.changeBlock < r.baseline.block;
    const open = r.status.status === "RED";
    out.push({
      id: `change-${r.change.changeBlock}`,
      kind: "change",
      title: open ? "Implementation changed" : superseded ? "Implementation changed (before current baseline)" : "Implementation changed (since returned to baseline)",
      detail:
        `${r.change.field} moved from ${r.change.previousValue} to ${r.change.newValue}, detected by ${r.change.detectedBy}.` +
        (superseded ? ` The baseline in force was established later, at block ${r.baseline.block}.` : ""),
      at: r.change.detectedAt,
      block: r.change.changeBlock,
      txHash: r.change.txHash || null,
      tone: open ? "bad" : "warn",
      investigable: true,
    });
  }

  if (r.changeNote) {
    out.push({
      id: `note-${r.changeNote.changeBlock}`,
      kind: "explanation",
      title: "Change explanation generated",
      detail: r.changeNote.sameSurface
        ? `${r.changeNote.model} described the change: same call surface, different code.`
        : `${r.changeNote.model} described the change: ${r.changeNote.selectorsAdded} selectors added, ${r.changeNote.selectorsRemoved} removed.`,
      at: r.changeNote.generatedAt,
      block: r.changeNote.changeBlock,
      txHash: null,
      tone: "info",
      investigable: true,
    });
  }

  // A monitoring gap is not a record on Arkiv; it is the absence of a fresh one. Say which — and
  // for a contract you baselined yourself there is no watcher involved at all, so the reason is
  // that your own read has not returned, not that a record expired.
  if (!r.current) {
    out.push({
      id: "monitoring-gap",
      kind: "monitoring",
      title: r.source === "local" ? "Not checked yet" : "Monitoring unavailable",
      detail:
        r.source === "local"
          ? "Your browser has not completed a read of this contract, so there is nothing to compare against the baseline yet."
          : "No watcher record for this contract on Arkiv: it was never written, or it expired. Either way Argos has no observation to compare against the baseline.",
      at: null, block: null, txHash: null, tone: "warn", investigable: false,
    });
  } else if (r.source === "arkiv" && now - r.current.checkedAt > 300) {
    out.push({
      id: "monitoring-stale",
      kind: "monitoring",
      title: "Monitoring stale",
      detail: `The newest watcher record is from block ${r.current.checkedBlock}, older than the 5-minute freshness line.`,
      at: r.current.checkedAt, block: r.current.checkedBlock, txHash: null, tone: "warn", investigable: false,
    });
  }

  out.push({
    id: "baseline",
    kind: "baseline",
    title: "Baseline established",
    detail: r.baseline.reason
      ? `Trust anchor recorded (${r.baseline.reason}). Everything observed since is compared against it.`
      : "Trust anchor recorded. Everything observed since is compared against it.",
    at: r.baseline.baselinedAt,
    block: r.baseline.block,
    txHash: null,
    tone: "ok",
    investigable: false,
  });

  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || Number((b.block ?? 0n) - (a.block ?? 0n)));
}

/* --------------------------------------------------------------- hooks */

/** Shared Arkiv state: one bulk read, refreshed at most every ARKIV_REFRESH_MS. */
export function useArkiv() {
  const [snap, setSnap] = useState<ArkivSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSnap(await readArkiv());
      setError(null);
    } catch (err) {
      setError(
        err instanceof ArkivRateLimitedError
          ? err.message
          : `Arkiv read failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, ARKIV_REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);
  return { snap, error, loading, refresh };
}

export function useManifest() {
  const [manifest, setManifest] = useState<RegistryManifest | null>(null);
  useEffect(() => {
    loadManifest().then(setManifest, () => setManifest(null));
  }, []);
  return manifest;
}

export type ArkivState = ReturnType<typeof useArkiv>;
