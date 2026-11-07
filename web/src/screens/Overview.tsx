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

/**
 * The hero visual: a field of blocks under a slow sweep, with one cell diverging each cycle and
 * a trace drawing itself across.
 *
 * It is abstract on purpose — it is not charting anyone's data — but it is not arbitrary either:
 * the grid is blocks, the sweep is a reading passing over them, and the single red cell is the
 * event the whole product exists to notice. Entirely CSS-animated off a static SVG, so it costs
 * one paint and stops dead under prefers-reduced-motion.
 */
const COLS = 9;
const ROWS = 6;
const CELL = 30;
const GAP = 8;

function ScanField() {
  const w = COLS * (CELL + GAP) - GAP;
  const h = ROWS * (CELL + GAP) - GAP;
  // The cell that diverges: deliberately off-centre, so the composition is not a bullseye.
  const flagCol = 6;
  const flagRow = 2;

  return (
    <div className="scan">
      <svg viewBox={`-10 -10 ${w + 20} ${h + 56}`} role="presentation">
        <defs>
          <linearGradient id="argos-sweep" x1="0" x2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0" />
            <stop offset="0.5" stopColor="var(--accent)" stopOpacity="0.20" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
          <clipPath id="argos-field">
            <rect x="-10" y="-10" width={w + 20} height={h + 20} />
          </clipPath>
        </defs>

        {/* the field */}
        {Array.from({ length: ROWS }, (_, r) =>
          Array.from({ length: COLS }, (_, c) => {
            const isFlag = c === flagCol && r === flagRow;
            return (
              <rect
                key={`${r}-${c}`}
                className={isFlag ? "scan-flag" : "scan-cell"}
                x={c * (CELL + GAP)}
                y={r * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx="4"
                style={isFlag ? undefined : { animationDelay: `${((c * 7 + r * 11) % 24) * 0.3}s` }}
              />
            );
          }),
        )}

        {/* the divergence, announced once per cycle */}
        <rect
          className="scan-halo"
          x={flagCol * (CELL + GAP) - 5}
          y={flagRow * (CELL + GAP) - 5}
          width={CELL + 10}
          height={CELL + 10}
          rx="7"
          strokeWidth="1.5"
        />

        {/* the sweep */}
        <g clipPath="url(#argos-field)">
          <rect className="scan-sweep" x="-40" y="-10" width="80" height={h + 20} fill="url(#argos-sweep)" />
        </g>

        {/* baseline held flat, observation tracking it then stepping away at the flagged column */}
        <path className="scan-trace base" d={`M0 ${h + 28} H${w}`} />
        <path
          className="scan-trace obs"
          d={`M0 ${h + 28} H${flagCol * (CELL + GAP)} L${flagCol * (CELL + GAP) + 22} ${h + 16} H${w}`}
        />
      </svg>
    </div>
  );
}

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
        <div className="hero-split">
          <div>
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

          <div className="hero-visual" aria-hidden>
            <ScanField />
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
