import { useState } from "react";
import { TransportPill } from "./components/common.tsx";
import { MonitoredScreen, useArkiv, useManifest } from "./screens/Monitored.tsx";
import { CheckTxScreen } from "./screens/CheckTx.tsx";
import { NymDiagnosticsScreen } from "./screens/NymDiagnostics.tsx";

type Tab = "monitored" | "check" | "nym";
const TABS: { id: Tab; label: string }[] = [
  { id: "monitored", label: "Monitored contracts" },
  { id: "check", label: "Check a transaction" },
  { id: "nym", label: "Nym diagnostics" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("monitored");
  const arkiv = useArkiv();
  const manifest = useManifest();
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
        <TransportPill />
      </header>
      <main>
        {tab === "monitored" && <MonitoredScreen arkiv={arkiv} manifest={manifest} />}
        {tab === "check" && <CheckTxScreen snap={arkiv.snap} manifest={manifest} />}
        {tab === "nym" && <NymDiagnosticsScreen />}
      </main>
      <footer className="foot">
        DriftGuard detects, verifies and warns. It does not block transactions or guarantee safety, and an upgrade is not a
        sign of malice. Code: MIT. Descriptors: ERC-7730 registry (CC0).
      </footer>
    </div>
  );
}
