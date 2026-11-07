/**
 * The command centre, for the contracts *you* watch.
 *
 * Deliberately sparse. The previous version stated the same four counts twice — once in the hero
 * and again as metric cards — and closed every panel with a paragraph of architecture notes. Both
 * are gone: the counts appear once, the explanations live on How It Works, and anything that
 * cannot be acted on is not here.
 */
import { useMemo } from "react";
import type { Status } from "@driftguard/core";
import { contractEvents, type ArkivState, type ContractEvent, type MonitoredRow } from "../lib/rows.ts";
import type { useWatchlist } from "../lib/watchlist.ts";
import { contractHref } from "../lib/router.ts";
import { ContractTable } from "../components/ContractTable.tsx";
import { AsOf, Callout, Card, CardHead, Empty, LiveDot, Metric, Reveal, ago } from "../components/common.tsx";
import { Icon, type IconName } from "../components/icons.tsx";

const KIND_ICON: Record<ContractEvent["kind"], IconName> = {
  baseline: "shieldCheck",
  change: "alert",
  explanation: "spark",
  monitoring: "question",
  descriptor: "file",
};

export function OverviewScreen({
  rows, watch, arkiv, now, fleetCount,
}: {
  rows: MonitoredRow[];
  watch: ReturnType<typeof useWatchlist>;
  arkiv: ArkivState;
  now: number;
  fleetCount: number;
}) {
  const count = (s: Status) => rows.filter((r) => r.status.status === s).length;
  const empty = rows.length === 0;

  const activity = useMemo(
    () =>
      rows
        .flatMap((r) => contractEvents(r, now).map((e) => ({ e, r })))
        .sort((a, b) => (b.e.at ?? 0) - (a.e.at ?? 0))
        .slice(0, 6),
    [rows, now],
  );

  return (
    <div className="page">
      {/* ---------------------------------------------------------- hero */}
      <section className="band hero">
        <div className="hero-art grid-backdrop" aria-hidden />
        <div style={{ position: "relative" }}>
          <div className="row" style={{ gap: "var(--s-2)", marginBottom: "var(--s-5)" }}>
            <LiveDot tone={empty ? "neutral" : watch.checking ? "info" : "ok"} idle={empty} />
            <span className="eyebrow">
              {empty ? "No contracts yet" : watch.checking ? "Checking" : `Watching ${rows.length}`}
            </span>
          </div>

          <h1 className="display">Know what changed before you sign.</h1>

          <p className="page-sub">
            Argos records the code behind a contract when you trust it, then tells you when that code changes.
          </p>

          <div className="row" style={{ marginTop: "var(--s-6)", gap: "var(--s-3)" }}>
            <a className="btn primary lg" href="#/add">Add a contract</a>
            <a className="btn lg" href="#/how">How it works</a>
          </div>
        </div>
      </section>

      {arkiv.error && (
        <Callout tone="warn">
          <b>{arkiv.error}</b>
        </Callout>
      )}

      {empty ? (
        <Card>
          <Empty
            icon="inbox"
            title="You aren't watching anything yet"
            action={
              <div className="row" style={{ justifyContent: "center" }}>
                <a className="btn primary" href="#/add">Add a contract</a>
                <a className="btn" href="#/contracts">Browse the {fleetCount} Argos monitors</a>
              </div>
            }
          >
            Add a contract and Argos will record its current code as your baseline, then check it against the chain
            every time you open this page.
          </Empty>
        </Card>
      ) : (
        <>
          <Reveal>
            <div className="metrics">
              <Metric label="Watching" value={rows.length} />
              <Metric label="Matches baseline" value={count("GREEN")} tone="ok" />
              <Metric label="Changed" value={count("RED")} tone="bad" />
              <Metric label="Not verified" value={count("NOT_VERIFIED")} tone="warn" />
            </div>
          </Reveal>

          <Reveal>
            <Card>
              <CardHead
                title="Your contracts"
                actions={
                  <div className="row" style={{ gap: "var(--s-2)" }}>
                    <button className="btn sm" onClick={() => void watch.refresh()} disabled={watch.checking}>
                      <Icon name="refresh" size={13} /> {watch.checking ? "Checking…" : "Check now"}
                    </button>
                    <a className="btn sm" href="#/contracts">All <Icon name="chevronRight" size={12} /></a>
                  </div>
                }
              />
              <ContractTable rows={rows} now={now} loading={watch.checking && rows.length === 0} compact />
            </Card>
          </Reveal>

          {activity.length > 0 && (
            <Reveal>
              <Card>
                <CardHead title="Recent activity" />
                <div className="feed">
                  {activity.map(({ e, r }) => (
                    <a
                      key={`${r.id}-${e.id}`}
                      className="feed-item"
                      href={contractHref(r.chainId, r.address, e.investigable ? "investigate" : "history", e.id)}
                    >
                      <span className={`tl-dot s-${e.tone}`}><Icon name={KIND_ICON[e.kind]} size={13} /></span>
                      <span className="feed-txt">
                        <span className="strong">{e.title}</span>
                        <span className="dimmer"> · {r.protocol}</span>
                        <span style={{ display: "block", marginTop: 4 }}>
                          <AsOf block={e.block} at={e.at} now={now} prefix="" />
                        </span>
                      </span>
                      <span className="feed-time">{e.at ? ago(e.at, now) : "—"}</span>
                    </a>
                  ))}
                </div>
              </Card>
            </Reveal>
          )}
        </>
      )}
    </div>
  );
}
