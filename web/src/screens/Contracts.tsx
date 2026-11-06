/**
 * My Contracts — the home of everything about a monitored contract, investigations included.
 * Filtering happens here; opening a row goes straight to that contract's workspace.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import type { Status } from "@driftguard/core";
import type { ArkivState, MonitoredRow } from "../lib/rows.ts";
import { CHAINS } from "../lib/config.ts";
import { pendingStore } from "../lib/pending.ts";
import { ContractTable } from "../components/ContractTable.tsx";
import { PageHead, type NetworkFilter } from "../components/Shell.tsx";
import { AddressLink, Badge, Callout, Card, CardHead, chainName, ago } from "../components/common.tsx";
import { Icon } from "../components/icons.tsx";

type StatusFilter = "all" | Status;

const STATUS_OPTIONS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All statuses" },
  { id: "RED", label: "Change detected" },
  { id: "NOT_VERIFIED", label: "Not verified" },
  { id: "GREEN", label: "Verified" },
];

export function ContractsScreen({
  rows, arkiv, now, network, setNetwork,
}: {
  rows: MonitoredRow[];
  arkiv: ArkivState;
  now: number;
  network: NetworkFilter;
  setNetwork: (n: NetworkFilter) => void;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const pending = useSyncExternalStore(pendingStore.subscribe, pendingStore.get, pendingStore.get);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== "all" && r.status.status !== status) return false;
      if (!needle) return true;
      return (
        r.protocol.toLowerCase().includes(needle) ||
        r.address.toLowerCase().includes(needle) ||
        r.baseline.implementation.toLowerCase().includes(needle) ||
        (r.current?.implementation.toLowerCase().includes(needle) ?? false) ||
        r.proxyKind.toLowerCase().includes(needle)
      );
    });
  }, [rows, q, status]);

  const attention = rows.filter((r) => r.status.status === "RED").length;
  const visiblePending = pending.filter((p) => network === "all" || p.chainId === network);

  return (
    <div className="page">
      <PageHead
        title="My Contracts"
        sub="Every contract Argos monitors for you, with the baseline it is compared against and the block that comparison was last made at. Open a contract to see its history, investigate a change and read the evidence behind it."
        actions={<a className="btn primary" href="#/add"><Icon name="add" size={15} /> Add a contract</a>}
      />

      {attention > 0 && (
        <Callout tone="bad">
          <b>{attention} contract{attention > 1 ? "s" : ""} no longer match{attention > 1 ? "" : "es"} its baseline.</b>{" "}
          Open the contract to see what changed, which selectors moved and what to investigate. Argos does not classify a
          change as safe or malicious.
        </Callout>
      )}

      <Card>
        <div className="filters">
          <div className="field">
            <label htmlFor="f-q">Search</label>
            <input
              id="f-q"
              className="input"
              type="search"
              value={q}
              placeholder="Name, proxy, implementation…"
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="f-net">Network</label>
            <select
              id="f-net"
              className="select"
              value={String(network)}
              onChange={(e) => setNetwork(e.target.value === "all" ? "all" : Number(e.target.value))}
            >
              <option value="all">All networks</option>
              {Object.values(CHAINS).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-status">Monitoring status</label>
            <select id="f-status" className="select" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Showing</label>
            <div className="row" style={{ height: 40 }}>
              <span className="mono t-13 dim">{filtered.length} of {rows.length}</span>
            </div>
          </div>
          <button
            className="btn"
            onClick={() => { setQ(""); setStatus("all"); setNetwork("all"); }}
            disabled={!q && status === "all" && network === "all"}
          >
            Clear
          </button>
        </div>

        <ContractTable
          rows={filtered}
          now={now}
          loading={arkiv.loading && !arkiv.snap}
          emptyAction={
            q || status !== "all" || network !== "all" ? (
              <button className="btn" onClick={() => { setQ(""); setStatus("all"); setNetwork("all"); }}>Clear filters</button>
            ) : (
              <a className="btn primary" href="#/add"><Icon name="add" size={15} /> Add a contract</a>
            )
          }
        />
      </Card>

      {visiblePending.length > 0 && (
        <Card stripe="info">
          <CardHead
            title="Awaiting baseline publication"
            sub="You reviewed these and asked Argos to monitor them. They are held in this browser only and are not yet monitored."
            icon="clock"
          />
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th style={{ width: 120 }}>Network</th>
                  <th style={{ width: 190 }}>Observed implementation</th>
                  <th style={{ width: 150 }}>Inspected at</th>
                  <th style={{ width: 90 }}><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {visiblePending.map((p) => (
                  <tr key={`${p.chainId}:${p.address}`}>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <span className="strong">{p.label}</span>
                        <Badge tone="info" icon="clock">Requested</Badge>
                      </div>
                      <div style={{ marginTop: 3 }}>
                        <AddressLink chainId={p.chainId} address={p.address} />
                      </div>
                    </td>
                    <td className="t-13 dim">{chainName(p.chainId)}</td>
                    <td><AddressLink chainId={p.chainId} address={p.implementation} /></td>
                    <td><span className="asof">block <b>{p.observedBlock}</b> · {ago(p.observedAt, now)}</span></td>
                    <td className="td-right">
                      <button className="btn sm ghost" onClick={() => pendingStore.remove(p.chainId, p.address)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-foot">
            Your browser holds no key, so it cannot publish a <span className="mono">dg_baseline</span> record. Monitoring
            starts once the Argos writer publishes the baseline you approved; until then these contracts have no status and
            are deliberately not shown as verified.
          </div>
        </Card>
      )}
    </div>
  );
}
