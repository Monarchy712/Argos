import { useCallback, useEffect, useMemo, useState } from "react";
import { computeStatus, PROXY_KINDS, type Status, type StatusResult } from "@driftguard/core";
import { readArkiv, idOf, ArkivRateLimitedError, type ArkivSnapshot, type BaselineRow, type ChangeRow, type CurrentRow } from "../lib/arkiv.ts";
import { ARKIV_EXPLORER, ARKIV_REFRESH_MS, DEMO_PROXY, TRUSTED_CREATORS } from "../lib/config.ts";
import { descriptorFor, loadManifest, type RegistryManifest } from "../lib/descriptors.ts";
import { AddressLink, StatusBadge, TxLink, ago, chainName, short, useNow } from "../components/common.tsx";

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
  descriptorHash: string | null;
  descriptorPath: string | null;
  status: StatusResult;
}

const ORDER: Record<Status, number> = { RED: 0, NOT_VERIFIED: 1, GREEN: 2 };
const detectionFor = (kind: string) => (kind === "safe" || kind === "none" ? "slot-only" : (PROXY_KINDS as readonly string[]).includes(kind) ? "event+slot" : "unsupported");

export function buildRows(snap: ArkivSnapshot, manifest: RegistryManifest | null, now: number): MonitoredRow[] {
  const cur = new Map(snap.current.map((c) => [idOf(c.chainId, c.address), c]));
  const chg = new Map(snap.changes.map((c) => [idOf(c.chainId, c.address), c]));
  return snap.baselines
    .map((b) => {
      const id = idOf(b.chainId, b.address);
      const current = cur.get(id) ?? null;
      const change = chg.get(id) ?? null;
      const desc = manifest ? descriptorFor(manifest, b.chainId, b.address) : null;
      const isDemo = id === idOf(DEMO_PROXY.chainId, DEMO_PROXY.address);
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
        protocol: isDemo ? DEMO_PROXY.label : desc ? desc.owner || desc.entity : "—",
        attested: !!desc?.attested,
        proxyKind: b.proxyKind,
        detection: current?.detection || detectionFor(b.proxyKind),
        baseline: b,
        current,
        change,
        descriptorHash: b.descriptorHash || desc?.descriptorHash || null,
        descriptorPath: desc?.path ?? null,
        status,
      };
    })
    .sort((a, b) => {
      const demo = (r: MonitoredRow) => (r.protocol === DEMO_PROXY.label ? 0 : 1);
      return demo(a) - demo(b) || ORDER[a.status.status] - ORDER[b.status.status] || a.protocol.localeCompare(b.protocol);
    });
}

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
      setError(err instanceof ArkivRateLimitedError ? err.message : `Arkiv read failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
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

function Tile({ label, value, cls }: { label: string; value: number | string; cls?: string }) {
  return (
    <div className={`card tile ${cls ?? ""}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
    </div>
  );
}

export function MonitoredScreen({ arkiv, manifest }: { arkiv: ReturnType<typeof useArkiv>; manifest: RegistryManifest | null }) {
  const now = useNow();
  const { snap, error, loading, refresh } = arkiv;
  const rows = useMemo(() => (snap ? buildRows(snap, manifest, now) : []), [snap, manifest, now]);
  const count = (s: Status) => rows.filter((r) => r.status.status === s).length;

  return (
    <section>
      <h1 className="section-title">Monitored contracts</h1>
      <p className="section-sub">
        ERC-7730 descriptors are bound to a contract address. When that address is an upgradeable proxy, its code can change
        while the descriptor keeps matching. Each contract below has a <b>baseline</b> (the code identity when it was
        recorded). The watcher compares the live code against it and publishes the result on Arkiv.
      </p>

      <div className="tiles">
        <Tile label="Monitored" value={rows.length} />
        <Tile label="Verified · no change" value={count("GREEN")} cls="tile-green" />
        <Tile label="Change detected" value={count("RED")} cls="tile-red" />
        <Tile label="Not verified" value={count("NOT_VERIFIED")} cls="tile-unk" />
      </div>

      <div className="row small muted" style={{ marginBottom: 10 }}>
        <span>
          {snap ? <>Read from Arkiv {ago(snap.readAt / 1000, now)} (block {snap.arkivBlock.toString()}, {snap.ms} ms)</> : loading ? "Reading Arkiv…" : "No Arkiv data yet"}
          {" · "}one bulk read per trusted writer, the same for every visitor (direct, keyless).
        </span>
        <button className="btn btn-small" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>
      {error && <div className="callout callout-red" style={{ marginBottom: 12 }}>{error} Contracts without fresh data show as Not verified.</div>}

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 210 }}>Status</th>
              <th>Contract</th>
              <th>Proxy · detection</th>
              <th>Baseline → current implementation</th>
              <th>Latest change</th>
              <th>Descriptor (ERC-8176)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.id} r={r} now={now} />
            ))}
            {snap && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">No baselines found from the trusted writer.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small muted" style={{ marginTop: 12 }}>
        Trusted Arkiv writers: baselines <a href={`${ARKIV_EXPLORER}/address/${TRUSTED_CREATORS.writer}`} target="_blank" rel="noreferrer" className="addr">{short(TRUSTED_CREATORS.writer)}</a>,
        watcher <a href={`${ARKIV_EXPLORER}/address/${TRUSTED_CREATORS.watcher}`} target="_blank" rel="noreferrer" className="addr">{short(TRUSTED_CREATORS.watcher)}</a>.
        Rows from any other creator are ignored. The watcher's records expire 10 minutes after its last write, so a stopped watcher turns contracts to Not verified.
      </p>
    </section>
  );
}

function Row({ r, now }: { r: MonitoredRow; now: number }) {
  const changed = r.current && r.current.implementation.toLowerCase() !== r.baseline.implementation.toLowerCase();
  const isZero = (a: string) => /^0x0{40}$/i.test(a);
  return (
    <tr className={r.status.status === "RED" ? "row-red" : undefined}>
      <td>
        <StatusBadge status={r.status.status} />
        <div className="note muted" title={r.status.reasons.join("\n")}>{r.status.status === "GREEN" && r.current ? `checked ${ago(r.current.checkedAt, now)}` : r.status.reasons[0]}</div>
        {r.status.note && <div className="note note-warn">{r.status.note}</div>}
      </td>
      <td>
        <div style={{ fontWeight: 600 }}>
          {r.protocol} {r.attested && <span className="kind" title="The registry has an auditor attestation (ERC-8176) for this descriptor">attested</span>}
        </div>
        <div className="small muted">
          {chainName(r.chainId)} · <AddressLink chainId={r.chainId} address={r.address} />
        </div>
      </td>
      <td>
        <span className="kind">{r.proxyKind}</span>
        <div className="small muted" style={{ marginTop: 4 }}>{r.detection}</div>
      </td>
      <td className="small">
        {r.proxyKind === "diamond" ? (
          <span className="muted">facets hash (diamond)</span>
        ) : isZero(r.baseline.implementation) ? (
          <span className="muted">—</span>
        ) : (
          <>
            <div>
              <span className="muted">baseline </span>
              <AddressLink chainId={r.chainId} address={r.baseline.implementation} />
            </div>
            <div className={changed ? "impl-diff" : undefined}>
              <span className="muted">current&nbsp; </span>
              {r.current ? <AddressLink chainId={r.chainId} address={r.current.implementation} /> : <span className="muted">no fresh record</span>}
            </div>
          </>
        )}
      </td>
      <td className="small">
        {r.change ? (
          <>
            <div>
              {r.change.field} · block {r.change.changeBlock.toString()} <span className="muted">({r.change.detectedBy})</span>
            </div>
            <TxLink chainId={r.chainId} tx={r.change.txHash} />
          </>
        ) : (
          <span className="muted">none since baseline</span>
        )}
      </td>
      <td className="small">
        {r.descriptorHash ? (
          <span className="addr" title={`${r.descriptorHash}${r.descriptorPath ? `\n${r.descriptorPath}` : ""}`}>{short(r.descriptorHash, 10, 6)}</span>
        ) : (
          <span className="muted">no registry descriptor</span>
        )}
        {r.descriptorPath && <div className="muted" style={{ fontSize: 12 }}>{r.descriptorPath.replace(/^registry\//, "")}</div>}
      </td>
    </tr>
  );
}
