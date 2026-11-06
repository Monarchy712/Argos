/**
 * How Argos works, for someone who has not read the architecture doc.
 *
 * The flow is the product's actual data path, in order, with one plain sentence per component and
 * the honest limitation attached to it. Nym is shown where it really sits — on the read path —
 * rather than as a logo in a list.
 */
import { NymDiagnosticsScreen } from "./NymDiagnostics.tsx";
import { Badge, Callout, Card, CardHead, Reveal } from "../components/common.tsx";
import { Icon, type IconName } from "../components/icons.tsx";

interface Node {
  kind: "chain" | "argos" | "store" | "ai";
  icon: IconName;
  title: string;
  tag?: string;
  desc: string;
  edge?: string;
}

const FLOW: Node[] = [
  {
    kind: "chain", icon: "chain", title: "The Ethereum contract", tag: "on chain",
    desc: "An upgradeable contract keeps its address forever, but the code behind that address can be replaced at any time. You sign transactions to the address; the code is what actually runs.",
    edge: "read every 60 s",
  },
  {
    kind: "argos", icon: "eye", title: "The Argos watcher", tag: "always running",
    desc: "A service that reads the contract's storage slots and scans its upgrade events from a saved position, so nothing is missed between restarts. It records what it sees — never an opinion about it.",
    edge: "compare",
  },
  {
    kind: "argos", icon: "shieldCheck", title: "Comparison against your baseline",
    desc: "Your baseline is the implementation you reviewed and chose to trust. Every reading is compared against it. Matching means no change was seen at that block; it never means the contract is safe. Argos never replaces a baseline on its own.",
    edge: "publish",
  },
  {
    kind: "store", icon: "database", title: "Arkiv records the monitoring state", tag: "public, queryable",
    desc: "The baseline, the latest reading and the latest change are published as records anyone can query and whose author they can check. Readings expire after ten minutes, so if the watcher stops, contracts turn to Not verified instead of quietly staying green.",
    edge: "store content",
  },
  {
    kind: "store", icon: "cloud", title: "Swarm stores the content", tag: "addressed by hash",
    desc: "Descriptor files and change explanations live on Swarm, referenced by a hash recorded on Arkiv. Argos re-computes that hash on everything it downloads and refuses to display anything that does not match.",
    edge: "describe the diff",
  },
  {
    kind: "ai", icon: "spark", title: "0G describes what changed in the code", tag: "description, not a verdict",
    desc: "When an implementation changes, a model compares the 4-byte function selectors found in both versions of the deployed code and writes a few plain sentences about what moved. It is a description of observed differences — not a security audit, and never a judgement about intent.",
    edge: "present",
  },
  {
    kind: "argos", icon: "overview", title: "The Argos dashboard",
    desc: "What you are looking at. It reads the records, verifies every hash itself, and shows a status with the block it was observed at — plus all the underlying evidence, so you never have to take its word for anything.",
  },
];

export function HowItWorksScreen() {
  return (
    <div className="page">
      <section className="band hero">
        <div style={{ position: "relative", maxWidth: "56ch" }}>
          <div className="eyebrow" style={{ marginBottom: "var(--s-4)" }}>How it works</div>
          <h1 className="display">The address stays the same. The code does not.</h1>
          <p className="page-sub" style={{ color: "var(--band-muted)" }}>
            A wallet decides what to show you from the contract&rsquo;s <i>address</i>. An upgradeable contract can
            replace its code and keep that address — so the wallet keeps rendering a confident, readable description of
            code that is no longer the code being run.
          </p>
          <p className="prose" style={{ color: "var(--band-muted)", marginTop: "var(--s-4)" }}>
            Argos records what the code was when you decided to trust it, watches for it changing, and shows you the
            evidence when it does. That is the whole product.
          </p>
        </div>
      </section>

      <Card>
        <CardHead title="The path your monitoring data takes" sub="Each step, in order, with what it can and cannot tell you." icon="layers" />
        <div className="card-body">
          <div className="flow">
            {FLOW.map((n, i) => (
              <Reveal key={n.title} delay={i * 50}>
                <div className={`flow-node k-${n.kind}`}>
                  <span className="n-glyph"><Icon name={n.icon} size={19} /></span>
                  <div>
                    <div className="n-title">
                      {n.title}
                      {n.tag && <Badge tone={n.kind === "ai" ? "warn" : n.kind === "store" ? "info" : undefined}>{n.tag}</Badge>}
                    </div>
                    <p className="n-desc">{n.desc}</p>
                  </div>
                </div>

                {i === 0 && (
                  <div className="flow-side" style={{ margin: "var(--s-3) 0 var(--s-3) var(--s-9)" }}>
                    <Icon name="lock" size={15} style={{ color: "var(--accent-2)", marginTop: 1 }} />
                    <span>
                      <b style={{ color: "var(--ink)" }}>Nym, where enabled.</b> Reads your browser makes can travel through
                      the Nym mixnet, so the node answering them sees a Nym exit instead of your IP address — it learns that
                      someone asked about a contract, not that <i>you</i> did. This is on by default; you can switch it off
                      in the sidebar, and every result stays labelled with the route it took.
                    </span>
                  </div>
                )}

                {n.edge && (
                  <div className="flow-arrow">
                    <Icon name="arrowDown" size={14} />
                    <span className="label">{n.edge}</span>
                  </div>
                )}
              </Reveal>
            ))}
          </div>
        </div>
      </Card>

      <div className="metrics" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <Card>
          <div className="card-body stack-s">
            <span className="eyebrow">What Argos tells you</span>
            <ul className="reasons">
              <li>The code behind this address changed, at this block, in this transaction.</li>
              <li>These 4-byte function selectors were added or removed.</li>
              <li>The descriptor your wallet would use no longer matches the one recorded at your baseline.</li>
              <li>Monitoring data is missing or stale, so nothing can be confirmed right now.</li>
            </ul>
          </div>
        </Card>
        <Card>
          <div className="card-body stack-s">
            <span className="eyebrow">What Argos never tells you</span>
            <ul className="reasons">
              <li>That a contract is safe, trustworthy or audited.</li>
              <li>That a change is malicious, or that no change means anything about future blocks.</li>
              <li>A score, a rating or a certification. Argos has none to give.</li>
              <li>That an AI explanation is a security verdict. It describes observed differences.</li>
            </ul>
          </div>
        </Card>
        <Card>
          <div className="card-body stack-s">
            <span className="eyebrow">Why a status can say Not verified</span>
            <ul className="reasons">
              <li>The watcher stopped, so its reading expired.</li>
              <li>The newest reading is older than five minutes.</li>
              <li>The contract's upgrade mechanism is not one Argos can read.</li>
              <li>A live read failed. Argos reports the failure rather than assuming nothing changed.</li>
            </ul>
          </div>
        </Card>
      </div>

      <Callout tone="warn" icon="alert">
        <b>Monitoring is not protection.</b> Argos tells you what it last observed. It cannot stop a contract being
        upgraded between the moment you check and the moment your transaction executes. The Transaction Guard tab on a
        supported contract demonstrates a check-and-call flow that closes that gap — for one proxy architecture, as a
        controlled demonstration, not as general protection.
      </Callout>

      <details className="disclose">
        <summary>
          <Icon name="chevronRight" size={13} className="chev" />
          Privacy routing diagnostics
          <span className="push" />
          <Badge tone="info" icon="lock">Nym</Badge>
        </summary>
        <div className="d-body">
          <NymDiagnosticsScreen />
        </div>
      </details>

      <p className="t-12 dimmer" style={{ lineHeight: 1.7 }}>
        Argos detects, verifies and warns. It does not block transactions or guarantee safety, and an upgrade is not a sign
        of malice. Code: MIT. Descriptors: ERC-7730 registry (CC0).
      </p>
    </div>
  );
}
