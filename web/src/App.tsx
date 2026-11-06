import { useEffect, useState } from "react";
import { TransportPill } from "./components/common.tsx";
import { primeNym } from "./lib/transport.ts";
import { MonitoredScreen, useArkiv, useManifest } from "./screens/Monitored.tsx";
import { CheckTxScreen } from "./screens/CheckTx.tsx";
import { NymDiagnosticsScreen } from "./screens/NymDiagnostics.tsx";
import { BrowseMirrorScreen } from "./screens/BrowseMirror.tsx";
import { HowItWorksScreen } from "./screens/HowItWorks.tsx";

type Tab = "monitored" | "check" | "browse" | "about" | "nym";
const TABS: { id: Tab; label: string }[] = [
  { id: "monitored", label: "Monitored contracts" },
  { id: "check", label: "Check a transaction" },
  { id: "browse", label: "Browse mirror" },
  { id: "about", label: "How it works" },
  { id: "nym", label: "Nym diagnostics" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("monitored");
  const arkiv = useArkiv();
  const manifest = useManifest();
  // Boot the Nym worker while the viewer reads this page, so the first check doesn't wait for it.
  useEffect(() => primeNym(), []);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" stroke="#e2e8f0" strokeWidth="1.8" fill="none" strokeLinejoin="round" /><circle cx="12" cy="12" r="3.6" fill="#22c55e" /><circle cx="12" cy="12" r="1.4" fill="#0f172a" /></svg>
          </span>
          Argos <small>watches the code behind clear-signing descriptors</small>
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
        {tab === "browse" && <BrowseMirrorScreen manifest={manifest} />}
        {tab === "about" && <HowItWorksScreen />}
        {tab === "nym" && <NymDiagnosticsScreen />}
      </main>
      <footer className="foot">
        Argos detects, verifies and warns. It does not block transactions or guarantee safety, and an upgrade is not a
        sign of malice. Code: MIT. Descriptors: ERC-7730 registry (CC0).
      </footer>
    </div>
  );
}
