/**
 * One contract, one place. Monitoring, history, investigation, evidence and the guard demo are
 * tabs inside this workspace rather than separate modules, so a user who sees a change never has
 * to navigate away and find the same contract again somewhere else.
 */
import type { ArkivState, MonitoredRow } from "../../lib/rows.ts";
import { contractEvents } from "../../lib/rows.ts";
import type { RegistryManifest } from "../../lib/descriptors.ts";
import type { WatchlistState } from "../../lib/watchlist.ts";
import { CONTRACT_TABS, contractHref, type ContractTab } from "../../lib/router.ts";
import { AddressLink, AsOf, Badge, Empty, StatusBadge, chainName } from "../../components/common.tsx";
import { Icon } from "../../components/icons.tsx";
import { TabOverview } from "./TabOverview.tsx";
import { TabHistory } from "./TabHistory.tsx";
import { TabInvestigate } from "./TabInvestigate.tsx";
import { TabEvidence } from "./TabEvidence.tsx";
import { TabGuard } from "./TabGuard.tsx";

const TAB_LABEL: Record<ContractTab, string> = {
  overview: "Overview",
  history: "Changes & History",
  investigate: "Investigate Change",
  evidence: "Evidence",
  guard: "Transaction Guard",
};

export interface TabProps {
  row: MonitoredRow;
  manifest: RegistryManifest | null;
  now: number;
  focusEvent: string | null;
  /** the two stores a tab can ask to re-read: the watcher snapshot, and this browser's own checks */
  arkiv: ArkivState;
  watch: WatchlistState;
}

export function ContractWorkspace({
  row, chainId, address, tab, focusEvent, arkiv, watch, manifest, now,
}: {
  row: MonitoredRow | null;
  chainId: number;
  address: string;
  tab: ContractTab;
  focusEvent: string | null;
  arkiv: ArkivState;
  watch: WatchlistState;
  manifest: RegistryManifest | null;
  now: number;
}) {
  if (!row) {
    return (
      <div className="page">
        <div className="card">
          {arkiv.loading && !arkiv.snap ? (
            <Empty icon="clock" title="Loading monitoring records">
              Reading the baseline and observation records for this contract from Arkiv.
            </Empty>
          ) : (
            <Empty
              icon="question"
              title="Argos has no baseline for this contract"
              action={
                <div className="row">
                  <a className="btn primary" href="#/add"><Icon name="add" size={15} /> Inspect and add it</a>
                  <a className="btn" href="#/contracts">Back to My Contracts</a>
                </div>
              }
            >
              <span className="mono">{address}</span> on {chainName(chainId)} is not monitored, so there is nothing to
              compare against. Argos can inspect it and help you decide whether to establish a baseline.
            </Empty>
          )}
        </div>
      </div>
    );
  }

  const events = contractEvents(row, now);
  const changeCount = events.filter((e) => e.kind === "change").length;
  const hasChange = row.change !== null;
  const tabProps: TabProps = { row, manifest, now, focusEvent, arkiv, watch };

  return (
    <>
      <div className="ws-head">
       <div className="ws-head-inner">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="#/contracts">My Contracts</a>
          <Icon name="chevronRight" size={12} />
          <span className="mono">{row.protocol}</span>
        </nav>

        <div className="page-head" style={{ alignItems: "center" }}>
          <div className="grow stack-s">
            <div className="row" style={{ gap: "var(--s-3)" }}>
              <h1 className="page-title">{row.protocol}</h1>
              {row.isDemo && <Badge tone="info">Demo contract</Badge>}
              {row.attested && <Badge icon="file">Attested descriptor</Badge>}
              <Badge>{row.proxyKind}</Badge>
            </div>
            <div className="row t-13 dim" style={{ gap: "var(--s-3)" }}>
              <span>{chainName(row.chainId)}</span>
              <AddressLink chainId={row.chainId} address={row.address} full />
            </div>
          </div>

          <div className="stack-s" style={{ justifyItems: "end", textAlign: "right" }}>
            <StatusBadge status={row.status.status} large />
            {row.current ? (
              <AsOf block={row.current.checkedBlock} at={row.current.checkedAt} now={now} />
            ) : (
              <AsOf block={row.baseline.block} prefix="baseline at" />
            )}
          </div>
        </div>

        <div className="tabs" role="tablist" aria-label="Contract sections">
          {CONTRACT_TABS.map((t) => (
            <a
              key={t}
              role="tab"
              aria-selected={tab === t}
              className="tab"
              href={contractHref(row.chainId, row.address, t)}
            >
              {TAB_LABEL[t]}
              {t === "history" && events.length > 0 && <span className="pill">{events.length}</span>}
              {t === "investigate" && hasChange && <span className="pill is-bad">{changeCount}</span>}
              {t === "guard" && <span className="pill is-exp">EXP</span>}
            </a>
          ))}
        </div>
       </div>
      </div>

      <div className="page">
        {tab === "overview" && <TabOverview {...tabProps} />}
        {tab === "history" && <TabHistory {...tabProps} />}
        {tab === "investigate" && <TabInvestigate {...tabProps} />}
        {tab === "evidence" && <TabEvidence {...tabProps} />}
        {tab === "guard" && <TabGuard {...tabProps} />}
      </div>
    </>
  );
}
