/**
 * The application frame: one rail, one header, four primary destinations. Every screen renders
 * inside this, so navigation, status language and the network filter never change shape between
 * pages.
 *
 * There is no wallet connector here on purpose. Argos holds no key: Arkiv is read keyless and
 * chain reads are `eth_call`s. The rail says so rather than showing a Connect button that would
 * imply the app can sign or write something.
 */
import { useMemo, useState, type ReactNode } from "react";
import { CHAINS } from "../lib/config.ts";
import { contractHref, navigate, type Route } from "../lib/router.ts";
import { routeLabel, restartNym, transport } from "../lib/transport.ts";
import type { MonitoredRow } from "../lib/rows.ts";
import { AsOf, Badge, StatusBadge, Tip, chainName, short, useDismiss, useTransport } from "./common.tsx";
import { Icon, type IconName } from "./icons.tsx";

export type NetworkFilter = "all" | number;

const NAV: { id: Route["name"]; label: string; icon: IconName; href: string }[] = [
  { id: "overview", label: "Overview", icon: "overview", href: "#/" },
  { id: "contracts", label: "My Contracts", icon: "contracts", href: "#/contracts" },
  { id: "add", label: "Add Contract", icon: "add", href: "#/add" },
  { id: "how", label: "How It Works", icon: "how", href: "#/how" },
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
  const [railOpen, setRailOpen] = useState(false);
  const attention = rows.filter((r) => r.status.status === "RED").length;
  // "My Contracts" owns investigations now, so its badge has to carry that signal in the rail.
  const active = route.name === "contract" ? "contracts" : route.name;

  return (
    <div className="shell">
      <aside className="rail" data-open={railOpen} id="argos-rail">
        <div className="rail-brand">
          <span className="mark"><Icon name="eye" size={17} style={{ color: "var(--accent)" }} /></span>
          <span className="word">Argos</span>
        </div>

        <nav className="rail-nav" aria-label="Primary">
          {NAV.map((n) => (
            <a
              key={n.id}
              href={n.href}
              className="nav-item"
              aria-current={active === n.id ? "page" : undefined}
              onClick={() => setRailOpen(false)}
            >
              <Icon name={n.icon} size={16} />
              {n.label}
              {n.id === "contracts" && attention > 0 && <span className="count is-bad">{attention}</span>}
            </a>
          ))}

          <div className="nav-group" style={{ marginTop: "var(--s-6)" }}>
            <span className="eyebrow">Monitoring</span>
            <div style={{ padding: "0 var(--s-3)" }}>
              <p className="t-12 dimmer" style={{ lineHeight: 1.6 }}>
                Argos reports what it observed at a block. It never certifies that a contract is safe.
              </p>
            </div>
          </div>
        </nav>

        <div className="rail-foot">
          <NetworkMenu network={network} setNetwork={setNetwork} />
          <TransportControl />
          <AccountMenu />
        </div>
      </aside>

      {railOpen && <div className="scrim" onClick={() => setRailOpen(false)} aria-hidden />}

      <div className="content">
        <header className="header">
          <button
            className="icon-btn rail-toggle"
            aria-label="Open navigation"
            aria-expanded={railOpen}
            aria-controls="argos-rail"
            onClick={() => setRailOpen(true)}
          >
            <Icon name="menu" size={17} />
          </button>

          <span className="chip hide-sm">
            <span className="net-dot" style={{ background: network === "all" ? "var(--info)" : "var(--ok)" }} />
            {network === "all" ? "All networks" : chainName(network)}
          </span>

          <GlobalSearch rows={rows} />

          <Notifications rows={rows} />
        </header>

        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- rail footer */

function NetworkMenu({ network, setNetwork }: { network: NetworkFilter; setNetwork: (n: NetworkFilter) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const options: { id: NetworkFilter; label: string }[] = [
    { id: "all", label: "All networks" },
    ...Object.values(CHAINS).map((c) => ({ id: c.id as NetworkFilter, label: c.name })),
  ];
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="rail-ctl" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu">
        <span className="net-dot" style={{ background: network === "all" ? "var(--info)" : "var(--ok)" }} />
        <span className="lines">
          <span className="l1">{network === "all" ? "All networks" : chainName(network)}</span>
          <span className="l2">{network === "all" ? `${options.length - 1} chains` : `chain ${network}`}</span>
        </span>
        <Icon name="chevronDown" size={14} className="chev" />
      </button>
      {open && (
        <div className="card" role="menu" style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, right: 0, zIndex: 40, boxShadow: "var(--shadow-2)", padding: 4 }}>
          {options.map((o) => (
            <button
              key={String(o.id)}
              role="menuitemradio"
              aria-checked={network === o.id}
              className="nav-item"
              onClick={() => {
                setNetwork(o.id);
                setOpen(false);
              }}
            >
              <Icon name={network === o.id ? "check" : "minus"} size={14} style={{ opacity: network === o.id ? 1 : 0.25 }} />
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The real connection state of this app: which route live chain reads take. Nym by default; a
 * switch to direct is an explicit, labelled opt-out, never silent.
 */
function TransportControl() {
  const t = useTransport();
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const [dot, halo] =
    t.mode === "direct" ? ["var(--warn)", "rgba(242,184,75,0.14)"]
    : t.nym.state === "ready" ? ["var(--ok)", "rgba(39,201,149,0.14)"]
    : t.nym.state === "failed" ? ["var(--bad)", "rgba(240,91,104,0.14)"]
    : ["var(--info)", "rgba(85,185,232,0.14)"];
  const sub =
    t.mode === "direct" ? "not anonymized"
    : t.nym.state === "ready" ? `ready${t.nym.bootMs ? ` · ${(t.nym.bootMs / 1000).toFixed(1)}s` : ""}`
    : t.nym.state === "failed" ? "failed" : "booting…";

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="rail-ctl" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="net-dot" style={{ background: dot, boxShadow: `0 0 0 3px ${halo}` }} />
        <span className="lines">
          <span className="l1">{t.mode === "nym" ? "Anon-RPC · Nym" : "Direct RPC"}</span>
          <span className="l2">{sub}</span>
        </span>
        <Icon name="chevronDown" size={14} className="chev" />
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, width: 300, zIndex: 40, boxShadow: "var(--shadow-2)" }}>
          <div className="card-body tight stack-s">
            <div className="sec-title t-13">Live read route</div>
            <p className="t-12 dim" style={{ lineHeight: 1.6 }}>
              Live chain reads go through the Nym mixnet by default, so the RPC provider sees a Nym exit
              instead of your IP. Direct is faster but <b>not anonymized</b>: the provider sees your IP and
              which contract you opened. Not saved — a reload returns to Nym.
            </p>
            <div className="row">
              {t.mode === "nym" ? (
                <button className="btn sm" onClick={() => { transport.setMode("direct"); setOpen(false); }}>Use direct RPC</button>
              ) : (
                <button className="btn sm primary" onClick={() => { transport.setMode("nym"); setOpen(false); }}>Back to Nym</button>
              )}
              {t.nym.state === "failed" && (
                <button className="btn sm" onClick={() => void restartNym().catch(() => {})}>Retry Nym</button>
              )}
            </div>
            {t.nym.state === "failed" && t.nym.error && (
              <p className="t-12" style={{ color: "var(--warn)" }}>{t.nym.error}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** No wallet connector: Argos reads, it never signs. The footer states that rather than hiding it. */
function AccountMenu() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="rail-ctl" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu">
        <span className="avatar" aria-hidden />
        <span className="lines">
          <span className="l1">Read-only session</span>
          <span className="l2">no wallet connected</span>
        </span>
        <Icon name="chevronDown" size={14} className="chev" />
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, width: 300, zIndex: 40, boxShadow: "var(--shadow-2)" }}>
          <div className="card-body tight stack-s">
            <div className="sec-title t-13">No wallet is connected</div>
            <p className="t-12 dim" style={{ lineHeight: 1.6 }}>
              Argos never asks for a wallet. It reads Arkiv without a key and reads chains with
              <code> eth_call</code>. Nothing in this app can sign, send or spend. Baseline records are
              published by the Argos writer, not by your browser.
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

/* ------------------------------------------------------------------ header */

function GlobalSearch({ rows }: { rows: MonitoredRow[] }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return rows
      .filter((r) => r.protocol.toLowerCase().includes(needle) || r.address.toLowerCase().includes(needle) || r.baseline.implementation.toLowerCase().includes(needle))
      .slice(0, 7);
  }, [q, rows]);

  return (
    <div ref={ref} className="search" style={{ position: "relative" }}>
      <Icon name="search" size={15} />
      <input
        type="search"
        value={q}
        placeholder="Search contracts by name, proxy or implementation…"
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
        <div className="card" style={{ position: "absolute", top: "calc(100% + 8px)", left: 0, right: 0, zIndex: 40, boxShadow: "var(--shadow-2)", padding: 4, maxHeight: 360, overflowY: "auto" }}>
          {matches.length === 0 ? (
            <div className="t-12 dimmer" style={{ padding: "var(--s-3)" }}>No monitored contract matches “{q.trim()}”.</div>
          ) : (
            matches.map((r) => (
              <a
                key={r.id}
                className="nav-item"
                href={contractHref(r.chainId, r.address)}
                onClick={() => { setQ(""); setOpen(false); }}
              >
                <Icon name="contracts" size={14} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", color: "var(--ink)", fontWeight: 600 }}>{r.protocol}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{chainName(r.chainId)} · {short(r.address, 10, 8)}</span>
                </span>
                <span className="push"><StatusBadge status={r.status.status} /></span>
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
      <button className="icon-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Notifications: ${changed.length} changes detected, ${unverified.length} not verified`}>
        <Icon name="bell" size={16} />
        {changed.length > 0 && <span className="pip" />}
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: 380, maxWidth: "calc(100vw - 32px)", zIndex: 40, boxShadow: "var(--shadow-2)" }}>
          <div className="card-head" style={{ padding: "var(--s-3) var(--s-4)" }}>
            <div className="grow sec-title t-13">Needs attention</div>
            <span className="eyebrow">{total}</span>
          </div>
          <div style={{ maxHeight: 400, overflowY: "auto" }}>
            {total === 0 ? (
              <div className="t-13 dim" style={{ padding: "var(--s-4)" }}>
                Every monitored contract matched its baseline at its last check. That is an observation, not a guarantee.
              </div>
            ) : (
              [...changed, ...unverified].map((r) => (
                <a
                  key={r.id}
                  href={contractHref(r.chainId, r.address, r.status.status === "RED" ? "investigate" : "overview")}
                  className="feed-item"
                  style={{ textDecoration: "none", color: "inherit" }}
                  onClick={() => setOpen(false)}
                >
                  <span className={`tl-dot s-${r.status.status === "RED" ? "bad" : "warn"}`} style={{ width: 24, height: 24 }}>
                    <Icon name={r.status.status === "RED" ? "alert" : "question"} size={12} />
                  </span>
                  <span className="feed-txt">
                    <b>{r.protocol}</b>
                    <div className="t-12 dim" style={{ marginTop: 2 }}>{r.status.reasons[0]}</div>
                    <div style={{ marginTop: 4 }}>
                      <AsOf block={r.current?.checkedBlock ?? r.baseline.block} at={r.current?.checkedAt} />
                    </div>
                  </span>
                  <Icon name="chevronRight" size={14} style={{ color: "var(--ink-3)", marginTop: 4 }} />
                </a>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Small reusable header for pages that are not a contract workspace. */
export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="grow">
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export { Badge, Tip, routeLabel };
