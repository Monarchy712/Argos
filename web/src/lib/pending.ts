/**
 * Baselines the viewer has asked for but that are not on Arkiv yet.
 *
 * Why this exists: the browser holds no key. A `dg_baseline` row is written with
 * ARKIV_WRITER_PRIVATE_KEY by the watcher/importer (watcher/src/arkivSink.ts), never by this app,
 * so "Add contract" cannot make monitoring start by itself and must not pretend otherwise. What
 * it can do is the real work — read the proxy's slots live, pull the registry evidence, and record
 * the viewer's reviewed decision — then show exactly which record the Argos writer has to publish.
 *
 * These rows live in this browser only. They are kept strictly separate from Arkiv rows
 * everywhere they surface, and they never produce a VERIFIED status: a requested baseline is a
 * request, not an observation.
 */
const KEY = "argos.pendingBaselines.v1";

export interface PendingBaseline {
  chainId: number;
  address: string;
  proxyKind: string;
  implementation: string;
  codeIdentity: string;
  /** block the inspection read, not a baseline block: the writer sets that when it publishes */
  observedBlock: string;
  observedAt: number;
  descriptorPath: string | null;
  descriptorHash: string | null;
  label: string;
}

const idOf = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

function read(): PendingBaseline[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PendingBaseline[]) : [];
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
  add(row: PendingBaseline) {
    const rows = [...read().filter((r) => idOf(r.chainId, r.address) !== idOf(row.chainId, row.address)), row];
    cache = rows;
    write(rows);
  },
  remove(chainId: number, address: string) {
    const rows = read().filter((r) => idOf(r.chainId, r.address) !== idOf(chainId, address));
    cache = rows;
    write(rows);
  },
  has(chainId: number, address: string) {
    return read().some((r) => idOf(r.chainId, r.address) === idOf(chainId, address));
  },
};
