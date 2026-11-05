/**
 * How the app reaches chains and descriptor mirrors.
 *
 *  - "nym" (default): every request goes through an AnonRpcWorker running the Nym anon-client
 *    in a sandboxed null-origin iframe. If Nym isn't ready or fails, the request FAILS. There is
 *    no silent fallback to direct RPC; the UI then shows NOT VERIFIED with the reason.
 *  - "direct": plain fetch, only when the viewer switches to it explicitly. Labelled "not
 *    anonymized" everywhere it applies, and never persisted (a reload returns to Nym).
 *
 * Arkiv reads are the one disclosed exception: Arkiv's RPC didn't answer through the Nym exit in
 * the spike, so they go direct as one bulk, contract-independent read (see lib/arkiv.ts).
 */
import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import { BOOTSTRAP_RPC_URL, NYM_SPECIFIER } from "./config.ts";

export type Mode = "nym" | "direct";
export type NymState = "idle" | "booting" | "ready" | "failed";

export interface TransportSnapshot {
  mode: Mode;
  nym: { state: NymState; bootMs: number | null; error: string | null; startedAt: number | null };
}

const BOOT_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000;

let snapshot: TransportSnapshot = { mode: "nym", nym: { state: "idle", bootMs: null, error: null, startedAt: null } };
const listeners = new Set<() => void>();
const set = (next: { mode?: Mode; nym?: Partial<TransportSnapshot["nym"]> }) => {
  snapshot = { ...snapshot, ...next, nym: { ...snapshot.nym, ...(next.nym ?? {}) } };
  listeners.forEach((l) => l());
};

export const transport = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => snapshot,
  setMode(mode: Mode) {
    set({ mode });
    if (mode === "nym") void startNym();
  },
};

// ---- worker logs (for the diagnostics screen) ----------------------------------------------
export interface WorkerLogLine {
  t: number;
  level: string;
  text: string;
}
export const workerLogs: WorkerLogLine[] = [];

// ---- Nym worker lifecycle --------------------------------------------------------------------
let worker: AnonRpcWorker | null = null;
let booting: Promise<void> | null = null;

/** Plain JSON-RPC over direct fetch, used ONLY for the harness bootstrap (specifier read). */
const bootstrapProvider = {
  async request({ method, params }: { method: string; params?: unknown[] }) {
    const res = await fetch(BOOTSTRAP_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? "bootstrap RPC error");
    return json.result;
  },
};

export function startNym(): Promise<void> {
  if (booting) return booting;
  const startedAt = performance.now();
  set({ nym: { state: "booting", error: null, startedAt: Date.now(), bootMs: null } });
  booting = (async () => {
    try {
      worker = new AnonRpcWorker({ address: NYM_SPECIFIER, preExisting: { rpcProvider: bootstrapProvider } });
      void collectLogs(worker);
      await withTimeout(worker.ready, BOOT_TIMEOUT_MS, `Nym worker not ready after ${BOOT_TIMEOUT_MS / 1000} s`);
      set({ nym: { state: "ready", bootMs: Math.round(performance.now() - startedAt) } });
    } catch (err) {
      set({ nym: { state: "failed", error: err instanceof Error ? err.message : String(err) } });
      worker?.close();
      worker = null;
      booting = null; // allow a retry
      throw err;
    }
  })();
  return booting;
}

export function restartNym(): Promise<void> {
  worker?.close();
  worker = null;
  booting = null;
  return startNym();
}

async function collectLogs(w: AnonRpcWorker) {
  try {
    for (;;) {
      const { level, args } = await w.acceptLog();
      workerLogs.push({ t: Date.now(), level, text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
      if (workerLogs.length > 300) workerLogs.shift();
    }
  } catch {
    /* worker closed or failed; its last lines are already collected */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

/**
 * The harness accepts only plain values in a fetch init (spec §9.4). viem and others pass an
 * AbortSignal and Headers objects, so reduce every request to method + plain headers + string
 * body before it reaches the worker.
 */
function plainInit(init?: RequestInit): { method?: string; headers?: Record<string, string>; body?: string } {
  const headers: Record<string, string> = {};
  if (init?.headers) new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  return {
    method: init?.method ?? "GET",
    headers,
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
  };
}

/** A fetch that honours the selected mode. In Nym mode it never falls back to direct. */
export async function anonAwareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (snapshot.mode === "direct") return fetch(url, init);
  await startNym(); // throws (→ request fails) if Nym can't boot
  if (!worker) throw new Error("Nym worker unavailable");
  return withTimeout(worker.fetch(url, plainInit(init)), REQUEST_TIMEOUT_MS, `Nym request timed out after ${REQUEST_TIMEOUT_MS / 1000} s`);
}

/** A human label for the route a request takes, shown next to every live result. */
export function routeLabel(mode: Mode): string {
  return mode === "nym" ? "via Anon-RPC (Nym mixnet)" : "direct RPC, not anonymized";
}

/**
 * Always through Nym, whatever the selected mode: used by the diagnostics screen (Test 4), whose
 * whole point is measuring the anonymized path. Fails if Nym can't boot.
 */
export async function nymOnlyFetch(url: string, init?: RequestInit): Promise<Response> {
  await startNym();
  if (!worker) throw new Error("Nym worker unavailable");
  return withTimeout(worker.fetch(url, plainInit(init)), REQUEST_TIMEOUT_MS, `Nym request timed out after ${REQUEST_TIMEOUT_MS / 1000} s`);
}
