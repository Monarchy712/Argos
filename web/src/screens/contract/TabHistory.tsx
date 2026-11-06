/**
 * Changes & history for one contract. This is what used to be a separate investigations module:
 * the record list lives with the contract, and selecting a change opens its investigation.
 */
import { useState } from "react";
import { contractEvents, type ContractEvent } from "../../lib/rows.ts";
import { contractHref } from "../../lib/router.ts";
import type { TabProps } from "./Workspace.tsx";
import {
  AddressLink, Badge, Callout, Card, CardHead, Empty, TxLink, ago, short,
} from "../../components/common.tsx";
import { Icon, type IconName } from "../../components/icons.tsx";

const KIND_ICON: Record<ContractEvent["kind"], IconName> = {
  baseline: "shieldCheck",
  change: "alert",
  explanation: "spark",
  monitoring: "question",
  descriptor: "file",
};

const KIND_LABEL: Record<ContractEvent["kind"], string> = {
  baseline: "Baseline",
  change: "Implementation change",
  explanation: "AI explanation",
  monitoring: "Monitoring",
  descriptor: "Descriptor",
};

type KindFilter = "all" | ContractEvent["kind"];

export function TabHistory({ row, now, focusEvent }: TabProps) {
  const [kind, setKind] = useState<KindFilter>("all");
  const all = contractEvents(row, now);
  const events = kind === "all" ? all : all.filter((e) => e.kind === kind);
  const kinds = [...new Set(all.map((e) => e.kind))];

  return (
    <>
      <Card>
        <CardHead
          title="Changes & history"
          sub="Every record Argos holds for this contract, newest first. Selecting an implementation change opens its investigation."
          icon="clock"
          actions={
            kinds.length > 1 ? (
              <div className="seg" role="group" aria-label="Filter by record type">
                <button aria-pressed={kind === "all"} onClick={() => setKind("all")}>All</button>
                {kinds.map((k) => (
                  <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
                ))}
              </div>
            ) : undefined
          }
        />

        <div className="card-body">
          {events.length === 0 ? (
            <Empty icon="inbox" title="No records of this type">
              Nothing of this kind has been recorded for this contract.
            </Empty>
          ) : (
            <div className="timeline">
              {events.map((e) => (
                <EventItem key={e.id} e={e} row={row} now={now} focused={focusEvent === e.id} />
              ))}
            </div>
          )}
        </div>

        <div className="card-foot">
          Arkiv holds one baseline and the <b>latest</b> change per contract
          (<span className="mono">dg_baseline</span>, <span className="mono">dg_latest_change</span>), so this list shows
          those records rather than a reconstructed log. Monitoring gaps are derived from the freshness of the watcher's
          own record, not from a stored event.
        </div>
      </Card>
    </>
  );
}

function EventItem({ e, row, now, focused }: { e: ContractEvent; row: TabProps["row"]; now: number; focused: boolean }) {
  const href = e.investigable ? contractHref(row.chainId, row.address, "investigate", e.id) : null;
  return (
    <div className={`tl-item s-${e.tone}`}>
      <span className="tl-dot"><Icon name={KIND_ICON[e.kind]} size={14} /></span>
      <div
        className="tl-body"
        style={
          focused
            ? { outline: "1px solid var(--iris-dim)", background: "var(--iris-soft)", borderRadius: "var(--r-sm)", padding: "var(--s-3)", marginTop: -3 }
            : undefined
        }
      >
        <div className="row" style={{ gap: "var(--s-2)" }}>
          <span className="tl-title">{e.title}</span>
          <Badge tone={e.tone === "neutral" ? undefined : e.tone}>{KIND_LABEL[e.kind]}</Badge>
          {focused && <Badge tone="info">Linked from activity</Badge>}
        </div>

        <p className="t-13 dim" style={{ lineHeight: 1.6 }}>{e.detail}</p>

        {e.kind === "change" && row.change && (
          <dl className="facts">
            <dt>Previous</dt>
            <dd><AddressLink chainId={row.chainId} address={row.change.previousValue} /></dd>
            <dt>New</dt>
            <dd><AddressLink chainId={row.chainId} address={row.change.newValue} tone="bad" /></dd>
            <dt>Upgrade transaction</dt>
            <dd><TxLink chainId={row.chainId} tx={row.change.txHash} /></dd>
          </dl>
        )}

        {e.kind === "explanation" && row.changeNote && (
          <dl className="facts">
            <dt>Model</dt>
            <dd className="mono">{row.changeNote.model}</dd>
            <dt>Text on Swarm</dt>
            <dd className="mono">{short(row.changeNote.summarySwarmRef, 12, 8)}</dd>
          </dl>
        )}

        <div className="row" style={{ gap: "var(--s-3)" }}>
          <span className="asof">
            {e.block != null && <>block <b>{e.block.toString()}</b></>}
            {e.block != null && e.at != null && " · "}
            {e.at != null ? ago(e.at, now) : "no timestamp recorded"}
          </span>
          {href && (
            <a className="btn sm" href={href}>
              Investigate this change <Icon name="chevronRight" size={13} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export { Callout };
