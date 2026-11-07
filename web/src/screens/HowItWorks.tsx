/**
 * How Argos works, shown rather than described.
 *
 * Each step leads with a drawn diagram of the actual mechanism — the slot that gets read, the
 * comparison that gets made, the selectors that get diffed — and the prose underneath is kept to
 * what the picture cannot say. No third-party logos: they are other people's marks, and fetching
 * them would hand a visitor's IP to a CDN on a page about not being observed.
 */
import { NymDiagnosticsScreen } from "./NymDiagnostics.tsx";
import { DiagramCompare, DiagramEvidence, DiagramProxy, DiagramRead, DiagramSelectors } from "../components/Diagrams.tsx";
import { Badge, Card, Reveal } from "../components/common.tsx";
import { Icon } from "../components/icons.tsx";

interface Chapter {
  n: string;
  title: string;
  body: string;
  diagram: React.ReactNode;
  note?: string;
}

const CHAPTERS: Chapter[] = [
  {
    n: "01",
    title: "An address is not its code",
    body:
      "Upgradeable contracts keep one permanent address and forward every call to a second contract that holds the actual logic. That second contract can be swapped at any time. Your wallet only ever sees the address, so it keeps showing the same confident description after the code behind it has been replaced.",
    diagram: <DiagramProxy />,
  },
  {
    n: "02",
    title: "Argos reads what decides the code",
    body:
      "At a fixed storage slot, every EIP-1967 proxy records which implementation it forwards to. Argos reads that slot, the admin slot and the implementation's codehash, and hashes them together into a single value: the code identity. Two equal identities mean the same code runs.",
    diagram: <DiagramRead />,
    note: "Beacon proxies, Safe proxies and diamonds are read the same way, from the slots each pattern defines.",
  },
  {
    n: "03",
    title: "You choose the baseline, not Argos",
    body:
      "When you add a contract, Argos records its identity now and asks you to accept it. That is the trust anchor, and it is a judgement only you can make — Argos has not audited the code and will never say it is safe. From then on every reading is compared against that anchor.",
    diagram: <DiagramCompare />,
    note: "A baseline is never replaced automatically. A contract that changes stays changed until you review it.",
  },
  {
    n: "04",
    title: "What changed, in terms of functions",
    body:
      "When an implementation changes, Argos recovers the 4-byte function selectors from the deployed bytecode of both versions and compares them. The interesting case is when nothing moved: identical selectors mean your wallet renders exactly the same thing, over different code.",
    diagram: <DiagramSelectors />,
    note: "A model on 0G then describes the difference in plain sentences. A description, never a verdict.",
  },
  {
    n: "05",
    title: "You can check all of it",
    body:
      "Every claim links to the record behind it. Monitoring state is published on Arkiv, signed by a writer whose address you can verify; longer content lives on Swarm, addressed by hash. Argos re-computes that hash on anything it downloads and renders nothing if it does not match.",
    diagram: <DiagramEvidence />,
  },
];

export function HowItWorksScreen() {
  return (
    <div className="page">
      <section className="band hero">
        <div className="hero-art grid-backdrop" aria-hidden />
        <div style={{ position: "relative" }}>
          <div className="eyebrow" style={{ marginBottom: "var(--s-5)" }}>How it works</div>
          <h1 className="display">The address stays. The code can change.</h1>
          <p className="page-sub">
            Five steps, from the storage slot Argos reads to the record you can check it against.
          </p>
        </div>
      </section>

      {CHAPTERS.map((c, i) => (
        <Reveal key={c.n} delay={i * 40}>
          <Card>
            <div className="card-body" style={{ display: "grid", gap: "var(--s-5)" }}>
              <div style={{ display: "flex", gap: "var(--s-4)", alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="eyebrow" style={{ color: "var(--accent)" }}>{c.n}</span>
                <h2 style={{ fontSize: "var(--t-h3)", flex: "1 1 320px", minWidth: 0 }}>{c.title}</h2>
              </div>

              <div
                style={{
                  background: "var(--canvas)", border: "1px solid var(--hairline)",
                  borderRadius: "var(--r-sm)", padding: "var(--s-4)", overflowX: "auto",
                }}
              >
                {c.diagram}
              </div>

              <p className="prose">{c.body}</p>
              {c.note && (
                <p className="t-12 dimmer" style={{ lineHeight: 1.6, maxWidth: "72ch" }}>{c.note}</p>
              )}
            </div>
          </Card>
        </Reveal>
      ))}

      <Reveal>
        <div className="metrics" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))" }}>
          <Card>
            <div className="card-body stack-s">
              <span className="eyebrow">What Argos tells you</span>
              <ul className="reasons">
                <li>The code behind this address changed, at this block, in this transaction.</li>
                <li>These function selectors were added or removed.</li>
                <li>Nothing could be confirmed right now, and why.</li>
              </ul>
            </div>
          </Card>
          <Card>
            <div className="card-body stack-s">
              <span className="eyebrow">What it never tells you</span>
              <ul className="reasons">
                <li>That a contract is safe, audited or trustworthy.</li>
                <li>That a change is malicious — upgrades are routine.</li>
                <li>A score or a rating. Argos has none to give.</li>
              </ul>
            </div>
          </Card>
          <Card>
            <div className="card-body stack-s">
              <span className="eyebrow">Privacy</span>
              <ul className="reasons">
                <li>Reads route through the Nym mixnet by default, so the RPC provider sees an exit, not you.</li>
                <li>Fonts and assets are served from this origin — nothing is fetched from a CDN.</li>
                <li>Switching to direct RPC is explicit, and every result stays labelled with its route.</li>
              </ul>
            </div>
          </Card>
        </div>
      </Reveal>

      <details className="disclose">
        <summary>
          <Icon name="chevronRight" size={13} className="chev" />
          Privacy routing diagnostics
          <span className="push" />
          <Badge tone="info">Nym</Badge>
        </summary>
        <div className="d-body">
          <NymDiagnosticsScreen />
        </div>
      </details>
    </div>
  );
}
