/**
 * Contract-onboarding attempts this browser has made, and what became of each one.
 *
 * WHAT CHANGED AND WHY. This used to be a list of locally saved wishes, all shown as "Awaiting
 * baseline publication" — which read like a queue somebody was working through, when in fact
 * nothing was queued anywhere and no baseline was ever going to appear. There is now a real
 * server-side publisher (lib/publish.ts → watcher/src/server.ts), so an entry records the actual
 * outcome instead:
 *
 *   needs-publisher  this build has no publisher configured; the request exists only here
 *   publishing       a request is in flight
 *   published        a dg_baseline row exists on Arkiv and the server read it back
 *   refused          the server declined, with a reason
 *   blocked          the publisher is disabled or misconfigured server-side
 *   unconfirmed      the write may have landed; it has not been confirmed
 *   failed           the request did not complete
 *
 * A `published` entry is dropped as soon as the contract shows up in the Arkiv snapshot, because
 * at that point the real row is the source of truth and this is just a stale copy of it. Nothing
 * here ever produces a VERIFIED status: these are requests and receipts, not observations.
 */
const KEY = "argos.pendingBaselines.v2";
/** The v1 key held rows with no outcome field. Read once, migrated, then left alone. */
const LEGACY_KEY = "argos.pendingBaselines.v1";

export type PendingStatus =
  | "needs-publisher"
  | "publishing"
  | "published"
  | "refused"
  | "blocked"
  | "unconfirmed"
  | "failed";

export interface PendingBaseline {
  chainId: number;
  address: string;
  proxyKind: string;
  implementation: string;
  codeIdentity: string;
  /** block the inspection read, not a baseline block: the server sets that when it publishes */
  observedBlock: string;
  observedAt: number;
  descriptorPath: string | null;
  descriptorHash: string | null;
  label: string;
  status: PendingStatus;
  /** The server's own words, when it had any. Shown verbatim rather than paraphrased. */
  detail: string;
  /** Arkiv entity key, set only for `published`. */
  entityKey?: string;
  /** unix seconds of the last status change */
  updatedAt: number;
}

/** Statuses that mean "nothing is going to happen without someone doing something". */
export const TERMINAL_STATUSES: readonly PendingStatus[] = ["published", "refused", "blocked", "failed"];

const idOf = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

function read(): PendingBaseline[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PendingBaseline[]) : [];
    }
    // Migrate v1 rows. They had no outcome, and the only honest reading of one is "this request
    // was never published", so they come across as needs-publisher rather than as pending.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return [];
    const old: unknown = JSON.parse(legacy);
    if (!Array.isArray(old)) return [];
    return (old as Omit<PendingBaseline, "status" | "detail" | "updatedAt">[]).map((r) => ({
      ...r,
      status: "needs-publisher" as PendingStatus,
      detail: "Recorded before Argos had a baseline publisher. It was never published; publish it again to start monitoring.",
      updatedAt: r.observedAt,
    }));
  } catch {
    return [];
  }
}

function write(rows: PendingBaseline[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    /* private mode or quota: the request is lost on reload, which is honest enough */
  }
  listeners.forEach((l) => l());
}

const listeners = new Set<() => void>();
let cache: PendingBaseline[] | null = null;

export const pendingStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  get(): PendingBaseline[] {
    cache ??= read();
    return cache;
  },
  /** Adds or replaces the entry for this contract. */
  upsert(row: PendingBaseline) {
    const rows = [...read().filter((r) => idOf(r.chainId, r.address) !== idOf(row.chainId, row.address)), { ...row, updatedAt: Math.floor(Date.now() / 1000) }];
    cache = rows;
    write(rows);
  },
  setStatus(chainId: number, address: string, status: PendingStatus, detail: string, entityKey?: string) {
    const rows = read().map((r) =>
      idOf(r.chainId, r.address) === idOf(chainId, address)
        ? { ...r, status, detail, entityKey: entityKey ?? r.entityKey, updatedAt: Math.floor(Date.now() / 1000) }
        : r,
    );
    cache = rows;
    write(rows);
  },
  remove(chainId: number, address: string) {
    const rows = read().filter((r) => idOf(r.chainId, r.address) !== idOf(chainId, address));
    cache = rows;
    write(rows);
  },
  /**
   * Drops entries for contracts that are now in the Arkiv snapshot. Once the real row is visible
   * there is nothing useful left in a local receipt, and keeping it would show the same contract
   * twice with two different stories.
   */
  reconcile(monitored: readonly { chainId: number; address: string }[]) {
    const live = new Set(monitored.map((m) => idOf(m.chainId, m.address)));
    const rows = read();
    const kept = rows.filter((r) => !live.has(idOf(r.chainId, r.address)));
    if (kept.length === rows.length) return;
    cache = kept;
    write(kept);
  },
  has(chainId: number, address: string) {
    return read().some((r) => idOf(r.chainId, r.address) === idOf(chainId, address));
  },
};
