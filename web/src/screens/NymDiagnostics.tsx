/**
 * Test 4: is Anon-RPC over Nym usable for DriftGuard's live checks? Twenty sequential
 * eth_getStorageAt reads of the Sepolia demo proxy's EIP-1967 implementation slot, ALWAYS through
 * the Nym worker (independent of the page's transport mode). Pass = at least 18/20 and p95 under
 * 10 s. After an upgrade, "Read once" should return the new implementation.
 */
import { useEffect, useState } from "react";
import { IMPLEMENTATION_SLOT } from "@driftguard/core";
import { CHAINS, DEMO_PROXY, NYM_SPECIFIER } from "../lib/config.ts";
import { nymOnlyFetch, restartNym, startNym, selectHarness, workerLogs, type HarnessVersion } from "../lib/transport.ts";
import { short, useTransport } from "../components/common.tsx";

/** The demo implementations (contracts/deployments/11155111.json). */
const IMPLS: Record<string, string> = {
  "0xcea0520134a8c0fcadc139bcd9faf5d3f712910f": "ImplA",
  "0x1f31ab6fe4c931ab7413523f75d490e1e0b63b4b": "ImplB",
};
const RPC_URL = CHAINS[DEMO_PROXY.chainId]!.rpcUrl;
const N = 20;
const PASS_MIN_OK = 18;
const PASS_P95_MS = 10_000;

interface ReadResult {
  i: number;
  ok: boolean;
  httpStatus: number | null;
  ms: number;
  impl?: string;
  error?: string;
}

async function readImplSlot(i: number): Promise<ReadResult> {
  const t0 = performance.now();
  try {
    const res = await nymOnlyFetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "eth_getStorageAt", params: [DEMO_PROXY.address, IMPLEMENTATION_SLOT, "latest"] }),
    });
    const ms = Math.round(performance.now() - t0);
    const text = await res.text();
    let json: { result?: string; error?: { message?: string } } = {};
    try {
      json = JSON.parse(text);
    } catch {
      return { i, ok: false, httpStatus: res.status, ms, error: `non-JSON response: ${text.slice(0, 80)}` };
    }
    if (!res.ok || json.error || !json.result) return { i, ok: false, httpStatus: res.status, ms, error: json.error?.message ?? `HTTP ${res.status}` };
    return { i, ok: true, httpStatus: res.status, ms, impl: `0x${json.result.slice(-40)}`.toLowerCase() };
  } catch (err) {
    return { i, ok: false, httpStatus: null, ms: Math.round(performance.now() - t0), error: err instanceof Error ? err.message : String(err) };
  }
}

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]! : NaN);

export function NymDiagnosticsScreen() {
  const t = useTransport();
  const [runs, setRuns] = useState<ReadResult[]>([]);
  const [running, setRunning] = useState(false);
  const [single, setSingle] = useState<ReadResult | null>(null);
  const [, force] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // While running, refresh every second (elapsed time, worker log).
  useEffect(() => {
    if (!running && t.nym.state !== "booting") return;
    const id = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [running, t.nym.state]);

  const okMs = runs.filter((r) => r.ok).map((r) => r.ms);
  const okCount = okMs.length;
  const p50 = pct(okMs, 50);
  const p95 = pct(okMs, 95);
  const statuses = runs.reduce<Record<string, number>>((m, r) => ((m[String(r.httpStatus ?? "no response")] = (m[String(r.httpStatus ?? "no response")] ?? 0) + 1), m), {});
  const done = runs.length === N && !running;
  const pass = done && okCount >= PASS_MIN_OK && p95 < PASS_P95_MS;

  async function run20() {
    setRunning(true);
    setRuns([]);
    setStartedAt(Date.now());
    try {
      await startNym();
    } catch (err) {
      // The worker never became ready: record all reads as failed now, don't retry per read.
      const error = `worker not ready: ${err instanceof Error ? err.message : String(err)}`;
      setRuns(Array.from({ length: N }, (_, k) => ({ i: k + 1, ok: false, httpStatus: null, ms: 0, error })));
      setRunning(false);
      return;
    }
    const out: ReadResult[] = [];
    for (let i = 1; i <= N; i++) {
      out.push(await readImplSlot(i));
      setRuns([...out]);
    }
    setRunning(false);
  }

  const summary = {
    test: "Test 4: Nym reads",
    at: new Date().toISOString(),
    specifier: NYM_SPECIFIER,
    rpc: RPC_URL,
    target: { chainId: DEMO_PROXY.chainId, proxy: DEMO_PROXY.address, slot: IMPLEMENTATION_SLOT },
    harness: t.nym.harness,
    bootMs: t.nym.bootMs,
    ok: `${okCount}/${runs.length}`,
    httpStatuses: statuses,
    p50Ms: p50,
    p95Ms: p95,
    implementations: [...new Set(runs.filter((r) => r.impl).map((r) => IMPLS[r.impl!] ?? r.impl))],
    verdict: done ? (pass ? "PASS" : "FAIL") : "incomplete",
    reads: runs,
  };

  return (
    <section>
      <h1 className="section-title">Nym diagnostics</h1>
      <p className="section-sub">
        Live checks use <a href="https://ethereum.github.io/anon-rpc/" target="_blank" rel="noreferrer">Anon-RPC</a>: a hash-pinned
        Nym mixnet client runs in a sandboxed, null-origin iframe, so the RPC provider sees a Nym exit, not your IP. This
        screen measures that path. Every read here goes through Nym, whatever the live-read setting.
      </p>

      <div className="grid-2">
        <div className="card card-pad stack">
          <div className="tile-label">Worker</div>
          <dl className="kv">
            <dt>specifier</dt><dd className="mono">{short(NYM_SPECIFIER, 10, 6)} (mainnet)</dd>
            <dt>state</dt><dd><b>{t.nym.state}</b>{t.nym.error ? ` · ${t.nym.error}` : ""}</dd>
            <dt>harness</dt>
            <dd>
              <select
                aria-label="Harness version"
                value={t.nym.harness}
                disabled={running || t.nym.state === "booting"}
                onChange={(e) => void selectHarness(e.target.value as HarnessVersion).catch(() => {})}
                style={{ width: "auto", fontFamily: "var(--sans)", padding: "2px 6px" }}
              >
                <option value="0.4.0">@anon-rpc/browser-harness 0.4.0 (current)</option>
                <option value="0.3.3">@anon-rpc/browser-harness 0.3.3 (spike-era)</option>
              </select>
            </dd>
            <dt>boot time</dt><dd>{t.nym.bootMs !== null ? `${(t.nym.bootMs / 1000).toFixed(1)} s` : "—"}</dd>
            <dt>page live reads</dt><dd>{t.mode === "nym" ? "Nym (default)" : "direct (switched by viewer)"}</dd>
          </dl>
          <div className="row">
            <button className="btn" onClick={() => void startNym().catch(() => {})} disabled={t.nym.state === "booting" || t.nym.state === "ready"}>
              Boot worker
            </button>
            <button className="btn" onClick={() => void restartNym().catch(() => {})} disabled={t.nym.state === "booting"}>
              Restart worker
            </button>
          </div>
        </div>

        <div className="card card-pad stack">
          <div className="tile-label">Test 4: {N} reads of the demo proxy's implementation slot</div>
          <p className="small muted" style={{ margin: 0 }}>
            <code>eth_getStorageAt</code>({short(DEMO_PROXY.address)}, EIP-1967 impl slot) on Sepolia via {new URL(RPC_URL).host}, sequential.
            Pass: ≥ {PASS_MIN_OK}/{N} and p95 &lt; {PASS_P95_MS / 1000} s.
          </p>
          <div className="row">
            <button className="btn btn-primary" onClick={() => void run20()} disabled={running}>
              {running ? (t.nym.state === "booting" ? `Booting worker… ${startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0} s` : `Running… ${runs.length}/${N}`) : `Run ${N} reads`}
            </button>
            <button className="btn" disabled={running} onClick={async () => setSingle(await readImplSlot(0))}>
              Read once (after an upgrade)
            </button>
            {runs.length > 0 && (
              <button className="btn" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(summary, null, 2))}>
                Copy results JSON
              </button>
            )}
          </div>
          {single && (
            <div className={`callout ${single.ok ? "" : "callout-red"}`}>
              {single.ok ? (
                <>
                  Implementation now: <b>{IMPLS[single.impl!] ?? "unknown"}</b> <span className="mono">{single.impl}</span> ({single.ms} ms via Nym)
                </>
              ) : (
                <>Read failed: {single.error}</>
              )}
            </div>
          )}
        </div>
      </div>

      {runs.length > 0 && (
        <>
          <div className="tiles" style={{ marginTop: 16 }}>
            <div className={`card tile ${done ? (pass ? "tile-green" : "tile-red") : ""}`}>
              <div className="tile-label">Verdict</div>
              <div className="tile-value">{done ? (pass ? "PASS" : "FAIL") : "…"}</div>
            </div>
            <div className="card tile">
              <div className="tile-label">Success</div>
              <div className="tile-value">{okCount}/{runs.length}</div>
            </div>
            <div className="card tile">
              <div className="tile-label">p50 / p95</div>
              <div className="tile-value" style={{ fontSize: 22 }}>{okCount ? `${(p50 / 1000).toFixed(2)} s / ${(p95 / 1000).toFixed(2)} s` : "—"}</div>
            </div>
            <div className="card tile">
              <div className="tile-label">HTTP statuses</div>
              <div className="tile-value" style={{ fontSize: 18 }}>{Object.entries(statuses).map(([k, v]) => `${k}×${v}`).join("  ")}</div>
            </div>
          </div>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr><th>#</th><th>result</th><th>HTTP</th><th>time</th><th>implementation</th></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.i}>
                    <td>{r.i}</td>
                    <td>{r.ok ? "ok" : <span style={{ color: "var(--bad-bg)" }}>{r.error}</span>}</td>
                    <td>{r.httpStatus ?? "—"}</td>
                    <td>{r.ms} ms</td>
                    <td className="mono small">{r.impl ? `${IMPLS[r.impl] ?? ""} ${short(r.impl, 8, 6)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="tile-label">Worker log (last 40 lines)</div>
          <button className="btn btn-small" onClick={() => force((x) => x + 1)}>Refresh log</button>
        </div>
        <div className="hex" style={{ maxHeight: 220, marginTop: 8 }}>
          {workerLogs.length === 0 ? <span className="muted">No worker output yet.</span> : workerLogs.slice(-40).map((l, i) => <div key={i}>[{new Date(l.t).toLocaleTimeString()}] {l.level}: {l.text}</div>)}
        </div>
      </div>
    </section>
  );
}
