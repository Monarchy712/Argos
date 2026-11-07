/**
 * My Contracts — yours first, and by default only yours.
 *
 * "Yours" means contracts you added (baselined in this browser and verified by its own live reads)
 * and the Sepolia proxies this deployment's operator deployed. The registry contracts the Argos
 * watcher monitors on Arkiv are a different population; they are still reachable, but behind a
 * deliberate switch, because a list that opens on 30 registry entries you never chose is not
 * *your* list.
 */
import { useMemo, useState } from "react";
import type { Status } from "@driftguard/core";
import type { ArkivState, MonitoredRow } from "../lib/rows.ts";
import type { useWatchlist } from "../lib/watchlist.ts";
import { CHAINS } from "../lib/config.ts";
import { ContractTable } from "../components/ContractTable.tsx";
import { PageHead, type NetworkFilter } from "../components/Shell.tsx";
import { Callout, Card, Empty } from "../components/common.tsx";
import { Icon } from "../components/icons.tsx";

type Scope = "mine" | "network";
type StatusFilter = "all" | Status;

const STATUS_OPTIONS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "Any status" },
  { id: "RED", label: "Changed" },
  { id: "NOT_VERIFIED", label: "Not verified" },
  { id: "GREEN", label: "Matches baseline" },
];

export function ContractsScreen({
  rows, fleet, watch, arkiv, now, network, setNetwork,
}: {
  rows: MonitoredRow[];
  fleet: MonitoredRow[];
  watch: ReturnType<typeof useWatchlist>;
  arkiv: ArkivState;
  now: number;
  network: NetworkFilter;
  setNetwork: (n: NetworkFilter) => void;
}) {
  const [scope, setScope] = useState<Scope>("mine");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const networkRows = fleet;
  const source = scope === "mine" ? rows : networkRows;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return source.filter((r) => {
      if (status !== "all" && r.status.status !== status) return false;
      if (!needle) return true;
      return (
        r.protocol.toLowerCase().includes(needle) ||
        r.address.toLowerCase().includes(needle) ||
        r.baseline.implementation.toLowerCase().includes(needle) ||
        (r.current?.implementation.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [source, q, status]);

  const changed = rows.filter((r) => r.status.status === "RED").length;

  return (
    <div className="page">
      <PageHead
        title="My Contracts"
        sub="Contracts you added, checked against the baseline you set each time you open Argos."
        actions={
          <div className="row" style={{ gap: "var(--s-2)" }}>
            <button className="btn" onClick={() => void watch.refresh()} disabled={watch.checking || rows.length === 0}>
              <Icon name="refresh" size={14} /> {watch.checking ? "Checking…" : "Check now"}
            </button>
            <a className="btn primary" href="#/add">Add a contract</a>
          </div>
        }
      />

      {changed > 0 && scope === "mine" && (
        <Callout tone="bad">
          <b>{changed} of your contracts no longer match the baseline you set.</b> Open it to see what changed.
          Argos does not classify a change as safe or malicious.
        </Callout>
      )}

      <Card>
        <div className="filters">
          <div className="field">
            <label htmlFor="f-scope">Showing</label>
            <div className="seg" id="f-scope" role="group" aria-label="Which contracts">
              <button aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>Yours · {rows.length}</button>
              <button aria-pressed={scope === "network"} onClick={() => setScope("network")}>
                Argos network · {networkRows.length}
              </button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="f-q">Search</label>
            <input id="f-q" className="input" type="search" value={q} placeholder="Name or address…" onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="f-net">Network</label>
            <select id="f-net" className="select" value={String(network)} onChange={(e) => setNetwork(e.target.value === "all" ? "all" : Number(e.target.value))}>
              <option value="all">All networks</option>
              {Object.values(CHAINS).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-status">Status</label>
            <select id="f-status" className="select" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              {STATUS_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {source.length === 0 && scope === "mine" ? (
          <Empty
            icon="inbox"
            title="You aren't watching anything yet"
            action={
              <div className="row" style={{ justifyContent: "center" }}>
                <a className="btn primary" href="#/add">Add a contract</a>
                <button className="btn" onClick={() => setScope("network")}>See what Argos monitors</button>
              </div>
            }
          >
            Argos records a contract's current code as your baseline, then compares the chain against it.
          </Empty>
        ) : (
          <ContractTable
            rows={filtered}
            now={now}
            loading={scope === "mine" ? watch.checking && filtered.length === 0 : arkiv.loading && !arkiv.snap}
            emptyAction={
              q || status !== "all" ? (
                <button className="btn" onClick={() => { setQ(""); setStatus("all"); }}>Clear filters</button>
              ) : undefined
            }
          />
        )}

        <div className="card-foot">
          {scope === "mine"
            ? "Contracts marked Demo are the Sepolia proxies this deployment's operator deployed; the watcher checks them continuously. Contracts you added without a published baseline are stored in this browser and checked by its own reads, so they survive a reload but not a different device — and only while this page is open."
            : "Published by the Argos writer and observed continuously by the watcher, independently of this browser."}
        </div>
      </Card>
    </div>
  );
}
