/**
 * The command centre. It answers one question before anything else: are the contracts I monitor
 * currently matching their trusted baselines, and as of which block?
 *
 * The hero is the thesis — the status triad and the block it was observed at, drawn from the same
 * live Arkiv read that feeds the table below it, never a decorative number. Recent activity links
 * straight into the contract it happened to; there is no separate investigations module.
 */
import { useMemo } from "react";
import type { Status } from "@driftguard/core";
import { contractEvents, type ArkivState, type ContractEvent, type MonitoredRow } from "../lib/rows.ts";
import { contractHref } from "../lib/router.ts";
import { ARKIV_EXPLORER, TRUSTED_CREATORS } from "../lib/config.ts";
import { ContractTable } from "../components/ContractTable.tsx";
import { type NetworkFilter } from "../components/Shell.tsx";
import {
  AsOf, Callout, Card, CardHead, LiveDot, Metric, Reveal, Skeleton, ago, chainName, short,
} from "../components/common.tsx";
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

  const attention = count("RED") + count("NOT_VERIFIED");

  return (
    <div className="page">
      {/* ---------------------------------------------------------- hero */}
      <section className="band hero">
        <HeroArt />
        <div style={{ position: "relative", maxWidth: "58ch" }}>
          <div className="row" style={{ gap: "var(--s-2)", marginBottom: "var(--s-4)" }}>
            <LiveDot tone={snap ? "ok" : "info"} idle={!snap} />
            <span className="eyebrow">
              {snap ? "Monitoring live" : loading ? "Reading Arkiv" : "Monitoring unavailable"}
            </span>
          </div>

          <h1 className="display">Know what changed before you trust what you&rsquo;re signing.</h1>

          <p className="page-sub" style={{ color: "var(--band-muted)" }}>
            Argos watches the code behind the contracts you interact with. Every status below is an
            observation at a specific block — not a claim that a contract is safe.
          </p>

          <div className="row" style={{ marginTop: "var(--s-6)", gap: "var(--s-3)" }}>
            <a className="btn primary lg" href="#/add"><Icon name="add" size={16} /> Add a contract</a>
            <a className="btn lg" href="#/contracts">
              View all contracts <Icon name="arrowRight" size={15} />
            </a>
          </div>
        </div>

        {/* Live readout: the same snapshot that feeds the table, stated plainly. */}
        <div
          className="row"
          style={{
            position: "relative", marginTop: "var(--s-8)", gap: "var(--s-6)",
            paddingTop: "var(--s-5)", borderTop: "1px solid var(--band-line)",
          }}
        >
          <HeroStat k="Monitored" v={snap ? String(rows.length) : "—"} />
          <HeroStat k="Verified" v={snap ? String(count("GREEN")) : "—"} tone="var(--ok)" />
          <HeroStat k="Change detected" v={snap ? String(count("RED")) : "—"} tone="var(--bad)" />
          <HeroStat k="Not verified" v={snap ? String(count("NOT_VERIFIED")) : "—"} tone="var(--warn)" />
          <span className="push asof hide-sm">
            {snap
              ? <>Arkiv block <b>{snap.arkivBlock.toString()}</b> · read {ago(snap.readAt / 1000, now)} in {snap.ms} ms</>
              : loading ? "reading…" : "no snapshot"}
          </span>
        </div>
      </section>

      {error && (
        <Callout tone="warn">
          <b>{error}</b> Contracts without a fresh record are shown as Not verified rather than assumed unchanged.
        </Callout>
      )}

      {/* ------------------------------------------------------- metrics */}
      <Reveal>
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
      </Reveal>

      {/* -------------------------------------------------- health table */}
      <Reveal>
        <Card>
          <CardHead
            title="Contract health"
            sub="Baseline against the most recent observation, for every contract Argos monitors."
            actions={
              <div className="row" style={{ gap: "var(--s-2)" }}>
                <button className="btn sm" onClick={() => void refresh()} disabled={loading}>
                  <Icon name="refresh" size={13} /> {loading ? "Reading…" : "Refresh"}
                </button>
                <a className="btn sm" href="#/contracts">View all <Icon name="chevronRight" size={13} /></a>
              </div>
            }
          />
          <ContractTable
            rows={rows}
            now={now}
            loading={loading && !snap}
            compact
            emptyAction={<a className="btn iris" href="#/add"><Icon name="add" size={15} /> Add a contract</a>}
          />
          {snap && (
            <div className="card-foot">
              One bulk read per trusted writer, identical for every visitor, so the node cannot tell which contract you
              care about. Watcher records expire ten minutes after the last write, so a stopped watcher turns contracts to
              Not verified rather than leaving them green.
            </div>
          )}
        </Card>
      </Reveal>

      {/* ----------------------------------------------------- activity */}
      <Reveal>
        <Card>
          <CardHead title="Recent activity" sub="Every entry opens the contract it belongs to." />
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
                  href={contractHref(r.chainId, r.address, e.investigable ? "investigate" : "history", e.id)}
                >
                  <span className={`tl-dot s-${e.tone}`}><Icon name={KIND_ICON[e.kind]} size={14} /></span>
                  <span className="feed-txt">
                    <span className="strong">{e.title}</span>
                    <span className="dimmer"> · {r.protocol}</span>
                    <span style={{ display: "block", marginTop: 3 }}>{e.detail}</span>
                    <span style={{ display: "block", marginTop: 5 }}>
                      <AsOf block={e.block} at={e.at} now={now} prefix="" />
                    </span>
                  </span>
                  <span className="feed-time">{e.at ? ago(e.at, now) : "—"}</span>
                </a>
              ))}
            </div>
          )}
          <div className="card-foot">
            Arkiv keeps the baseline and the latest change for each contract, so this feed shows those records rather than
            a synthesised history. Writers:{" "}
            <a className="mono" href={`${ARKIV_EXPLORER}/address/${TRUSTED_CREATORS.writer}`} target="_blank" rel="noreferrer">
              {short(TRUSTED_CREATORS.writer, 8, 6)}
            </a>{" "}
            (baselines),{" "}
            <a className="mono" href={`${ARKIV_EXPLORER}/address/${TRUSTED_CREATORS.watcher}`} target="_blank" rel="noreferrer">
              {short(TRUSTED_CREATORS.watcher, 8, 6)}
            </a>{" "}
            (observations). Rows from any other creator are ignored.
            {attention > 0 && (
              <> {attention} contract{attention === 1 ? "" : "s"} currently need{attention === 1 ? "s" : ""} attention.</>
            )}
          </div>
        </Card>
      </Reveal>
    </div>
  );
}

function HeroStat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <span style={{ display: "grid", gap: 2 }}>
      <span className="eyebrow">{k}</span>
      <span
        className="mono"
        style={{ fontSize: 28, fontWeight: 550, letterSpacing: "-0.03em", lineHeight: 1, color: tone ?? "var(--band-text)" }}
      >
        {v}
      </span>
    </span>
  );
}

/**
 * Hero art: a block-by-block observation trace, drawn rather than illustrated. The sweeping
 * dashes read left to right like the watcher advancing through blocks, and the one break in the
 * baseline line is where an implementation changed. It is a diagram of the product, not decoration.
 */
function HeroArt() {
  return (
    <div className="hero-art" aria-hidden>
      <svg viewBox="0 0 1200 420" preserveAspectRatio="xMaxYMid slice">
        <defs>
          <linearGradient id="argos-fade" x1="0" x2="1">
            <stop offset="0" stopColor="#5C63D8" stopOpacity="0" />
            <stop offset="0.55" stopColor="#5C63D8" stopOpacity="0.5" />
            <stop offset="1" stopColor="#5C63D8" stopOpacity="0.9" />
          </linearGradient>
          <linearGradient id="argos-fade-2" x1="0" x2="1">
            <stop offset="0" stopColor="#5FAE8C" stopOpacity="0" />
            <stop offset="1" stopColor="#5FAE8C" stopOpacity="0.55" />
          </linearGradient>
        </defs>

        {/* block ticks: the cadence the watcher reads at */}
        <g opacity="0.16">
          {Array.from({ length: 30 }, (_, i) => (
            <rect key={i} x={620 + i * 19} y={96} width="1.5" height={i % 5 === 0 ? 18 : 9} fill="#F4F5FB" rx="0.75" />
          ))}
        </g>

        {/* baseline trace, steady then departing */}
        <path
          d="M600 250 H840 L870 250 L900 214 H1180"
          fill="none" stroke="url(#argos-fade)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
        />
        {/* the observed trace that keeps to the baseline */}
        <path
          d="M600 292 H1180"
          fill="none" stroke="url(#argos-fade-2)" strokeWidth="2" strokeLinecap="round"
          className="sweep-path"
        />

        {/* the moment of divergence */}
        <circle cx="900" cy="214" r="5" fill="#DD7E90" />
        <circle cx="900" cy="214" r="11" fill="none" stroke="#DD7E90" strokeOpacity="0.4" strokeWidth="1.5" />

        {/* the watchful eye, drawn large and very quiet */}
        <g opacity="0.1" className="floaty">
          <path
            d="M905 60 C965 60 1015 112 1015 112 C1015 112 965 164 905 164 C845 164 795 112 795 112 C795 112 845 60 905 60 Z"
            fill="none" stroke="#F4F5FB" strokeWidth="2"
          />
          <circle cx="905" cy="112" r="26" fill="none" stroke="#F4F5FB" strokeWidth="2" />
        </g>
      </svg>
    </div>
  );
}
