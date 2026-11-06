/**
 * The application frame: a sticky translucent bar over a centred column.
 *
 * Four destinations do not need a permanent rail, and removing it gives the wide technical tables
 * the full measure of the page — which matters more here than anywhere, because the content is
 * 42-character addresses and 66-character hashes.
 *
 * There is no wallet connector, on purpose. Argos holds no key: Arkiv is read keyless and chain
 * reads are `eth_call`s. The session menu says so rather than showing a Connect button that would
 * imply the app can sign or write something.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CHAINS } from "../lib/config.ts";
import { contractHref, navigate, type Route } from "../lib/router.ts";
import { routeLabel, restartNym, transport } from "../lib/transport.ts";
import type { MonitoredRow } from "../lib/rows.ts";
import { AsOf, Badge, StatusBadge, chainName, short, useDismiss, useTransport } from "./common.tsx";
import { Icon, type IconName } from "./icons.tsx";

export type NetworkFilter = "all" | number;

const NAV: { id: Route["name"]; label: string; href: string }[] = [
  { id: "overview", label: "Overview", href: "#/" },
  { id: "contracts", label: "My Contracts", href: "#/contracts" },
  { id: "add", label: "Add Contract", href: "#/add" },
  { id: "how", label: "How It Works", href: "#/how" },
];

export function Shell({
  route, rows, network, setNetwork, children,
}: {
  route: Route;
  rows: MonitoredRow[];
  network: NetworkFilter;
  setNetwork: (n: NetworkFilter) => void;
  children: ReactNode;
}) {
  const [sheet, setSheet] = useState(false);
  const attention = rows.filter((r) => r.status.status === "RED").length;
  // My Contracts owns investigations, so its tab carries that signal.
  const active = route.name === "contract" ? "contracts" : route.name;

  useEffect(() => setSheet(false), [route.name, route.name === "contract" ? route.address : null]);

  return (
    <div className="shell">
      <header className="topnav">
        <div className="topnav-inner">
          <a className="brand" href="#/" aria-label="Argos home">
            <span className="mark"><ArgosMark size={18} /></span>
            <span className="word hide-sm">Argos</span>
          </a>

          <nav className="nav-links" aria-label="Primary">
            {NAV.map((n) => (
              <a key={n.id} href={n.href} className="nav-link" aria-current={active === n.id ? "page" : undefined}>
                {n.label}
                {n.id === "contracts" && attention > 0 && <span className="count">{attention}</span>}
              </a>
            ))}
          </nav>

          <div className="nav-tools">
            <GlobalSearch rows={rows} />
            <span className="hide-sm"><NetworkMenu network={network} setNetwork={setNetwork} /></span>
            <span className="hide-sm"><SessionMenu /></span>
            <Notifications rows={rows} />
            <button
              className="icon-btn nav-sheet-toggle"
              aria-label={sheet ? "Close navigation" : "Open navigation"}
              aria-expanded={sheet}
              onClick={() => setSheet((v) => !v)}
            >
              <Icon name={sheet ? "close" : "menu"} size={17} />
            </button>
          </div>
        </div>
      </header>

      {sheet && (
        <>
          <div className="nav-scrim" onClick={() => setSheet(false)} aria-hidden />
          <div className="nav-sheet">
            {NAV.map((n) => (
              <a key={n.id} href={n.href} className="menu-item" aria-current={active === n.id ? "page" : undefined}>
                {n.label}
                {n.id === "contracts" && attention > 0 && <span className="push"><Badge tone="bad">{attention}</Badge></span>}
              </a>
            ))}
            <div style={{ height: 1, background: "var(--divider)", margin: "var(--s-2) 0" }} />
            <NetworkMenu network={network} setNetwork={setNetwork} />
            <SessionMenu />
          </div>
        </>
      )}

      <div className="content">{children}</div>
    </div>
  );
}

/** The Argos mark: an eye, drawn — the hundred-eyed watchman, not a stock glyph. */
export function ArgosMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <path d="M2.5 12s3.6-6.2 9.5-6.2S21.5 12 21.5 12s-3.6 6.2-9.5 6.2S2.5 12 2.5 12Z"
            stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3.1" fill="#5C63D8" />
      <circle cx="12" cy="12" r="1.1" fill="#14172A" />
    </svg>
  );
}

/* ------------------------------------------------------------- controls */

function NetworkMenu({ network, setNetwork }: { network: NetworkFilter; setNetwork: (n: NetworkFilter) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const options: { id: NetworkFilter; label: string }[] = [
    { id: "all", label: "All networks" },
    ...Object.values(CHAINS).map((c) => ({ id: c.id as NetworkFilter, label: c.name })),
  ];
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="chip" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu">
        <span className={`live-dot ${network === "all" ? "d-info" : ""}`} />
        <span className="lines">
          <span className="l1">{network === "all" ? "All networks" : chainName(network)}</span>
        </span>
        <Icon name="chevronDown" size={13} style={{ color: "var(--faint)" }} />
      </button>
      {open && (
        <div className="menu" role="menu" style={{ top: "calc(100% + 8px)", right: 0, minWidth: 200 }}>
          {options.map((o) => (
            <button
              key={String(o.id)}
              role="menuitemradio"
              aria-checked={network === o.id}
              className="menu-item"
              onClick={() => { setNetwork(o.id); setOpen(false); }}
            >
              <Icon name="check" size={14} style={{ opacity: network === o.id ? 1 : 0.15 }} />
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The real connection state of this app: which route live reads take, and the fact that no key is
 * held. Nym by default; switching to direct is an explicit, labelled opt-out, never silent.
 */
function SessionMenu() {
  const t = useTransport();
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const dot =
    t.mode === "direct" ? "d-warn"
    : t.nym.state === "ready" ? ""
    : t.nym.state === "failed" ? "d-bad" : "d-info";
  const sub =
    t.mode === "direct" ? "Direct RPC"
    : t.nym.state === "ready" ? "Nym ready"
    : t.nym.state === "failed" ? "Nym failed" : "Nym booting";

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="chip" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu">
        <span className={`live-dot ${dot}`} />
        <span className="lines"><span className="l1">{sub}</span></span>
        <Icon name="chevronDown" size={13} style={{ color: "var(--faint)" }} />
      </button>
      {open && (
        <div className="menu" style={{ top: "calc(100% + 8px)", right: 0, width: 320, padding: "var(--s-4)" }}>
          <div className="stack-s">
            <span className="eyebrow">Live read route</span>
            <p className="t-12 dim" style={{ lineHeight: 1.6 }}>
              Chain reads go through the Nym mixnet by default, so the RPC provider sees a Nym exit instead
              of your IP. Direct is faster but <b>not anonymized</b>: the provider sees your IP and which
              contract you opened. Not saved — a reload returns to Nym.
            </p>
            {t.nym.state === "failed" && t.nym.error && (
              <p className="t-12" style={{ color: "var(--warn-ink)" }}>{t.nym.error}</p>
            )}
            <div className="row" style={{ gap: "var(--s-2)" }}>
              {t.mode === "nym" ? (
                <button className="btn sm" onClick={() => { transport.setMode("direct"); setOpen(false); }}>Use direct RPC</button>
              ) : (
                <button className="btn sm iris" onClick={() => { transport.setMode("nym"); setOpen(false); }}>Back to Nym</button>
              )}
              {t.nym.state === "failed" && (
                <button className="btn sm" onClick={() => void restartNym().catch(() => {})}>Retry Nym</button>
              )}
            </div>

            <div style={{ height: 1, background: "var(--divider)", margin: "var(--s-2) 0" }} />

            <span className="eyebrow">Session</span>
            <p className="t-12 dim" style={{ lineHeight: 1.6 }}>
              <b>No wallet is connected,</b> and Argos never asks for one. It reads Arkiv without a key and
              reads chains with <span className="mono">eth_call</span>. Nothing here can sign, send or spend.
              Baseline records are published by the Argos writer, not by your browser.
            </p>
            <a className="btn sm" href="#/how" onClick={() => setOpen(false)}>
              <Icon name="how" size={13} /> How Argos works
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function GlobalSearch({ rows }: { rows: MonitoredRow[] }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return rows
      .filter((r) =>
        r.protocol.toLowerCase().includes(needle) ||
        r.address.toLowerCase().includes(needle) ||
        r.baseline.implementation.toLowerCase().includes(needle))
      .slice(0, 7);
  }, [q, rows]);

  return (
    <div ref={ref} className="search">
      <Icon name="search" size={15} />
      <input
        type="search"
        value={q}
        placeholder="Search contracts…"
        aria-label="Search monitored contracts"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches[0]) {
            navigate(contractHref(matches[0].chainId, matches[0].address));
            setQ(""); setOpen(false);
          }
        }}
      />
      {open && q.trim() && (
        <div className="menu" style={{ top: "calc(100% + 8px)", left: 0, right: 0, maxHeight: 380, overflowY: "auto" }}>
          {matches.length === 0 ? (
            <div className="t-12 dimmer" style={{ padding: "var(--s-3)" }}>No monitored contract matches “{q.trim()}”.</div>
          ) : (
            matches.map((r) => (
              <a key={r.id} className="menu-item" href={contractHref(r.chainId, r.address)} onClick={() => { setQ(""); setOpen(false); }}>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", color: "var(--ink)", fontWeight: 550 }}>{r.protocol}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                    {chainName(r.chainId)} · {short(r.address, 10, 8)}
                  </span>
                </span>
                <StatusBadge status={r.status.status} />
              </a>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Notifications({ rows }: { rows: MonitoredRow[] }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const changed = rows.filter((r) => r.status.status === "RED");
  const unverified = rows.filter((r) => r.status.status === "NOT_VERIFIED");
  const total = changed.length + unverified.length;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="icon-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Notifications: ${changed.length} changes detected, ${unverified.length} not verified`}
      >
        <Icon name="bell" size={16} />
        {changed.length > 0 && <span className="pip" />}
      </button>
      {open && (
        <div className="menu" style={{ top: "calc(100% + 8px)", right: 0, width: 400, maxWidth: "calc(100vw - 32px)", padding: 0 }}>
          <div className="row" style={{ padding: "var(--s-4) var(--s-5)", borderBottom: "1px solid var(--divider)" }}>
            <span className="sec-title" style={{ flex: 1 }}>Needs attention</span>
            <span className="eyebrow">{total}</span>
          </div>
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {total === 0 ? (
              <div className="t-13 dim" style={{ padding: "var(--s-5)", lineHeight: 1.6 }}>
                Every monitored contract matched its baseline at its last check. That is an observation, not a
                guarantee.
              </div>
            ) : (
              [...changed, ...unverified].map((r) => (
                <a
                  key={r.id}
                  href={contractHref(r.chainId, r.address, r.status.status === "RED" ? "investigate" : "overview")}
                  className="feed-item"
                  onClick={() => setOpen(false)}
                >
                  <span className={`tl-dot s-${r.status.status === "RED" ? "bad" : "warn"}`}>
                    <Icon name={r.status.status === "RED" ? "alert" : "question"} size={14} />
                  </span>
                  <span className="feed-txt">
                    <span className="strong">{r.protocol}</span>
                    <span style={{ display: "block", marginTop: 3 }}>{r.status.reasons[0]}</span>
                    <span style={{ display: "block", marginTop: 5 }}>
                      <AsOf block={r.current?.checkedBlock ?? r.baseline.block} at={r.current?.checkedAt} />
                    </span>
                  </span>
                  <Icon name="chevronRight" size={14} style={{ color: "var(--faint)", marginTop: 4 }} />
                </a>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Page header for the non-workspace screens. */
export function PageHead({ title, sub, actions, eyebrow }: { title: string; sub?: ReactNode; actions?: ReactNode; eyebrow?: string }) {
  return (
    <div className="page-head">
      <div className="grow">
        {eyebrow && <div className="eyebrow" style={{ marginBottom: "var(--s-3)" }}>{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export { Badge, routeLabel };
export type { IconName };
