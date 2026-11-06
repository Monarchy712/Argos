/**
 * The command centre. It answers one question above everything else: are the contracts I monitor
 * currently matching their trusted baselines, and as of which block?
 *
 * Recent activity links straight into the contract it happened to — there is no separate
 * investigations module to go and search again in.
 */
import { useMemo } from "react";
import type { Status } from "@driftguard/core";
import { contractEvents, type ArkivState, type ContractEvent, type MonitoredRow } from "../lib/rows.ts";
import { contractHref } from "../lib/router.ts";
import { ARKIV_EXPLORER, TRUSTED_CREATORS } from "../lib/config.ts";
import { ContractTable } from "../components/ContractTable.tsx";
import { PageHead, type NetworkFilter } from "../components/Shell.tsx";
import { AsOf, Callout, Card, CardHead, Metric, Skeleton, ago, chainName, short } from "../components/common.tsx";
import { Icon, type IconName } from "../components/icons.tsx";

const KIND_ICON: Record<ContractEvent["kind"], IconName> = {
  baseline: "shieldCheck",
  change: "alert",
  explanation: "spark",
  monitoring: "question",
  descriptor: "file",
};

export function OverviewScreen({
  rows, arkiv, now, network,
}: { rows: MonitoredRow[]; arkiv: ArkivState; now: number; network: NetworkFilter }) {
  const { snap, error, loading, refresh } = arkiv;
  const count = (s: Status) => rows.filter((r) => r.status.status === s).length;

  const activity = useMemo(
    () =>
      rows
        .flatMap((r) => contractEvents(r, now).map((e) => ({ e, r })))
        .sort((a, b) => (b.e.at ?? 0) - (a.e.at ?? 0))
        .slice(0, 8),
    [rows, now],
  );

  return (
    <div className="page">
      <PageHead
        title="Your contracts, continuously monitored."
        sub={
          <>
            Each status below reflects the latest observation Argos could verify, at the block shown next to it.
            A verified result means no change was seen as of that block — it is not a statement that the contract
            is safe.
          </>
        }
        actions={
          <>
            <button className="btn" onClick={() => void refresh()} disabled={loading}>
              <Icon name="refresh" size={14} /> {loading ? "Reading…" : "Refresh"}
            </button>
            <a className="btn primary" href="#/add"><Icon name="add" size={15} /> Add a contract</a>
          </>
        }
      />

      {error && (
        <Callout tone="warn">
          <b>{error}</b> Contracts without a fresh record are shown as Not verified rather than assumed unchanged.
        </Callout>
      )}

      <div className="metrics">
        <Metric
          label="Contracts monitored"
          value={snap ? rows.length : "—"}
          note={network === "all" ? "across all networks" : chainName(network)}
          tip="A contract is monitored once a trusted baseline record exists for it on Arkiv."
        />
        <Metric
          label="Verified"
          value={snap ? count("GREEN") : "—"}
          tone="ok"
          note="matched baseline at last check"
          tip="The watcher read the contract recently and the code identity still matches the baseline. True as of that block only."
        />
        <Metric
          label="Change detected"
          value={snap ? count("RED") : "—"}
          tone="bad"
          note="differs from baseline"
          tip="A trusted source observed a code identity that differs from the baseline. Argos does not judge whether the change is benign."
        />
        <Metric
          label="Not verified"
          value={snap ? count("NOT_VERIFIED") : "—"}
          tone="warn"
          note="no fresh evidence"
          tip="Monitoring data is missing, expired or stale, or the proxy pattern cannot be read. Argos will not show these as verified."
        />
      </div>

      <Card>
        <CardHead
          title="Contract health"
          sub="Baseline versus the most recent observation, for every contract Argos monitors."
          actions={<a className="btn sm" href="#/contracts">View all <Icon name="chevronRight" size={13} /></a>}
        />
        <ContractTable
          rows={rows}
          now={now}
          loading={loading && !snap}
          compact
          emptyAction={<a className="btn primary" href="#/add"><Icon name="add" size={15} /> Add a contract</a>}
        />
        {snap && (
          <div className="card-foot">
            Read from Arkiv {ago(snap.readAt / 1000, now)} at block {snap.arkivBlock.toString()} in {snap.ms} ms — one bulk read
            per trusted writer, identical for every visitor, so the node cannot tell which contract you care about. Watcher
            records expire 10 minutes after the last write, so a stopped watcher turns contracts to Not verified rather than
            leaving them green.
          </div>
        )}
      </Card>

      <Card>
        <CardHead
          title="Recent activity"
          sub="Every entry opens the contract it belongs to."
          icon="clock"
        />
        {!snap && loading ? (
          <div className="card-body"><Skeleton lines={4} /></div>
        ) : activity.length === 0 ? (
          <div className="card-body t-13 dim">No recorded activity for the current filter.</div>
        ) : (
          <div className="feed">
            {activity.map(({ e, r }) => (
              <a
                key={`${r.id}-${e.id}`}
                className="feed-item"
                style={{ textDecoration: "none", color: "inherit" }}
                href={contractHref(r.chainId, r.address, e.investigable ? "investigate" : "history", e.id)}
              >
                <span className={`tl-dot s-${e.tone}`}>
                  <Icon name={KIND_ICON[e.kind]} size={13} />
                </span>
                <span className="feed-txt">
                  <span className="strong">{e.title}</span>
                  <span className="dim"> · {r.protocol}</span>
                  <div className="t-12 dim" style={{ marginTop: 2 }}>{e.detail}</div>
                  <div style={{ marginTop: 4 }}>
                    <AsOf block={e.block} at={e.at} now={now} prefix="" />
                  </div>
                </span>
                <span className="feed-time">{e.at ? ago(e.at, now) : "—"}</span>
              </a>
            ))}
          </div>
        )}
        <div className="card-foot">
          Arkiv keeps the baseline and the latest change for each contract, so this feed shows those records rather than a
          synthesised history. Writers:{" "}
          <a className="mono" href={`${ARKIV_EXPLORER}/address/${TRUSTED_CREATORS.writer}`} target="_blank" rel="noreferrer">
            {short(TRUSTED_CREATORS.writer, 8, 6)}
          </a>{" "}
          (baselines),{" "}
          <a className="mono" href={`${ARKIV_EXPLORER}/address/${TRUSTED_CREATORS.watcher}`} target="_blank" rel="noreferrer">
            {short(TRUSTED_CREATORS.watcher, 8, 6)}
          </a>{" "}
          (observations). Rows from any other creator are ignored.
        </div>
      </Card>
    </div>
  );
}
