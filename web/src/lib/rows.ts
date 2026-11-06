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
import { ARKIV_REFRESH_MS, DEMO_PROXY, GUARD_DEMO } from "./config.ts";
import { descriptorFor, loadManifest, type RegistryManifest } from "./descriptors.ts";

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
}

const ORDER: Record<Status, number> = { RED: 0, NOT_VERIFIED: 1, GREEN: 2 };

const detectionFor = (kind: string) =>
  kind === "safe" || kind === "none" ? "slot-only"
  : (PROXY_KINDS as readonly string[]).includes(kind) ? "event+slot"
  : "unsupported";

export function buildRows(snap: ArkivSnapshot, manifest: RegistryManifest | null, now: number): MonitoredRow[] {
  const cur = new Map(snap.current.map((c) => [idOf(c.chainId, c.address), c]));
  const chg = new Map(snap.changes.map((c) => [idOf(c.chainId, c.address), c]));
  const notes = new Map(snap.changeNotes.map((n) => [idOf(n.chainId, n.address), n]));

  return snap.baselines
    .map((b) => {
      const id = idOf(b.chainId, b.address);
      const current = cur.get(id) ?? null;
      const change = chg.get(id) ?? null;
      const desc = manifest ? descriptorFor(manifest, b.chainId, b.address) : null;
      const isDemoProxy = id === idOf(DEMO_PROXY.chainId, DEMO_PROXY.address);
      const isGuardDemo = id === idOf(GUARD_DEMO.chainId, GUARD_DEMO.proxy);
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
        protocol: isDemoProxy ? DEMO_PROXY.label : isGuardDemo ? GUARD_DEMO.label : desc ? desc.owner || desc.entity : "—",
        attested: !!desc?.attested,
        proxyKind: b.proxyKind,
        detection: current?.detection || detectionFor(b.proxyKind),
        baseline: b,
        current,
        change,
        changeNote: notes.get(id) ?? null,
        descriptorHash: b.descriptorHash || desc?.descriptorHash || null,
        descriptorPath: desc?.path ?? null,
        status,
        isDemo: isDemoProxy || isGuardDemo,
        guardable: isGuardDemo,
      };
    })
    .sort((a, b) => {
      const demo = (r: MonitoredRow) => (r.protocol === DEMO_PROXY.label ? 0 : r.protocol === GUARD_DEMO.label ? 1 : 2);
      return demo(a) - demo(b) || ORDER[a.status.status] - ORDER[b.status.status] || a.protocol.localeCompare(b.protocol);
    });
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

  // A monitoring gap is not a record on Arkiv; it is the absence of a fresh one. Say which.
  if (!r.current) {
    out.push({
      id: "monitoring-gap",
      kind: "monitoring",
      title: "Monitoring unavailable",
      detail: "No unexpired watcher record for this contract. Its current_state row expired (the watcher stopped) or was never written.",
      at: null, block: null, txHash: null, tone: "warn", investigable: false,
    });
  } else if (now - r.current.checkedAt > 300) {
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
