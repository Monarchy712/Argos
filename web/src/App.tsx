import { useState } from "react";

type Tab = "monitored" | "check" | "nym";
const TABS: { id: Tab; label: string }[] = [
  { id: "monitored", label: "Monitored contracts" },
  { id: "check", label: "Check a transaction" },
  { id: "nym", label: "Nym diagnostics" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("monitored");
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24"><path d="M5 13l4 4 10-11" stroke="#22c55e" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          DriftGuard <small>clear-signing drift monitor</small>
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        <p className="muted">Scaffold: {TABS.find((t) => t.id === tab)!.label}</p>
      </main>
      <footer className="foot">
        DriftGuard detects, verifies and warns. It does not block transactions or guarantee safety, and an upgrade is
        not a sign of malice.
      </footer>
    </div>
  );
}
