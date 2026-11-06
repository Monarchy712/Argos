import { useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import type { Status } from "@driftguard/core";
import { ARKIV_EXPLORER, CHAINS, SWARM_GATEWAY } from "../lib/config.ts";
import { transport, routeLabel, restartNym, type TransportSnapshot } from "../lib/transport.ts";

// ---- status badge: colour + icon + wording + border style all differ ------------------------
const BADGE: Record<Status, { cls: string; label: string; icon: ReactElement }> = {
  GREEN: {
    cls: "badge-green",
    label: "Verified · no change",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
        <path d="M5 13l4 4 10-11" stroke="currentColor" strokeWidth="3.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  RED: {
    cls: "badge-red",
    label: "Change detected",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
        <path d="M12 3L2 21h20L12 3z" fill="currentColor" />
        <path d="M12 10v5M12 18v.01" stroke="#b91c1c" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
    ),
  },
  NOT_VERIFIED: {
    cls: "badge-unverified",
    label: "Not verified",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2.6" />
        <path d="M9.3 9.4a2.8 2.8 0 1 1 3.6 2.7c-.6.2-.9.7-.9 1.3v.6M12 17.2v.01" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      </svg>
    ),
  },
};

export function StatusBadge({ status, large }: { status: Status; large?: boolean }) {
  const b = BADGE[status];
  return (
    <span className={`badge ${b.cls}${large ? " badge-lg" : ""}`} role="status" aria-label={b.label}>
      {b.icon}
      {b.label}
    </span>
  );
}

// ---- addresses / hashes / links -------------------------------------------------------------
/** Link to one Arkiv entity on the Rabdi explorer (anyone can open it and check $creator). */
export function ArkivLink({ entityKey, label }: { entityKey: string; label: string }) {
  return (
    <a className="ext-link ext-arkiv" href={`${ARKIV_EXPLORER}/entity/${entityKey}`} target="_blank" rel="noreferrer" title={`Arkiv entity ${entityKey}`}>
      {label}
    </a>
  );
}

/** Link to the raw bytes of a Swarm reference on the gateway the app reads from. */
export function SwarmLink({ swarmRef, label = "Swarm" }: { swarmRef: string; label?: string }) {
  return (
    <a className="ext-link ext-swarm" href={`${SWARM_GATEWAY}/bytes/${swarmRef}`} target="_blank" rel="noreferrer" title={`Swarm reference ${swarmRef}`}>
      {label}
    </a>
  );
}

export const short = (v: string, head = 6, tail = 4) => (v && v.length > head + tail + 2 ? `${v.slice(0, head)}…${v.slice(-tail)}` : v);

export function AddressLink({ chainId, address, full }: { chainId: number; address: string; full?: boolean }) {
  const explorer = CHAINS[chainId]?.explorer;
  const text = full ? address : short(address, 8, 6);
  return explorer ? (
    <a className="addr" href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer" title={address}>
      {text}
    </a>
  ) : (
    <span className="addr" title={address}>{text}</span>
  );
}

export function TxLink({ chainId, tx }: { chainId: number; tx: string }) {
  const explorer = CHAINS[chainId]?.explorer;
  if (!tx) return <span className="muted small">found by slot read (no tx)</span>;
  return explorer ? (
    <a className="addr" href={`${explorer}/tx/${tx}`} target="_blank" rel="noreferrer" title={tx}>
      tx {short(tx, 8, 6)}
    </a>
  ) : (
    <span className="addr">{short(tx)}</span>
  );
}

export const chainName = (id: number) => CHAINS[id]?.name ?? `chain ${id}`;

export function ago(unixSeconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - unixSeconds));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ---- hooks ---------------------------------------------------------------------------------
export function useTransport(): TransportSnapshot {
  return useSyncExternalStore(transport.subscribe, transport.get);
}

/** Re-render every `ms` so time-based status (staleness) stays honest without new data. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ---- transport pill (header) ---------------------------------------------------------------
export function TransportPill() {
  const t = useTransport();
  const [explaining, setExplaining] = useState(false);
  const nymText =
    t.nym.state === "ready" ? `ready${t.nym.bootMs ? ` (booted in ${(t.nym.bootMs / 1000).toFixed(1)} s)` : ""}`
    : t.nym.state === "booting" ? "booting…"
    : t.nym.state === "failed" ? "failed: checks show Not verified"
    : "starting…";
  return (
    <div className="transport-pill" style={{ position: "relative" }}>
      <div className="row small">
        <span className={t.mode === "direct" ? "kind kind-warn" : "kind"} title={routeLabel(t.mode)}>
          {t.mode === "nym" ? `Live reads: Anon-RPC / Nym · ${nymText}` : "Live reads: direct RPC (not anonymized)"}
        </span>
        {t.mode === "nym" ? (
          <>
            {t.nym.state === "failed" && (
              <button className="btn btn-small" onClick={() => void restartNym().catch(() => {})}>
                Retry Nym
              </button>
            )}
            <button className="btn btn-small" onClick={() => setExplaining((v) => !v)} aria-expanded={explaining}>
              Use direct RPC
            </button>
          </>
        ) : (
          <button className="btn btn-small" onClick={() => transport.setMode("nym")}>
            Back to Nym
          </button>
        )}
      </div>
      {explaining && t.mode === "nym" && (
        <div className="card card-pad popover" role="dialog" aria-label="Switch live reads to direct RPC">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Switch live reads to direct RPC?</div>
          <p className="small" style={{ margin: "0 0 10px", color: "var(--text-2)" }}>
            Live reads go through the Nym mixnet by default, so the RPC provider and the Swarm gateway see a Nym exit instead of
            your IP. Direct mode is faster (no ~10&nbsp;s tunnel setup) but <b>not anonymized</b>: the provider sees your IP and
            which contract you are checking. Every result stays labelled with the route it took, and you can switch back at any
            time. Not saved: a reload returns to Nym.
          </p>
          <div className="row">
            <button
              className="btn btn-small btn-primary"
              onClick={() => {
                transport.setMode("direct");
                setExplaining(false);
              }}
            >
              Use direct RPC
            </button>
            <button className="btn btn-small" onClick={() => setExplaining(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
