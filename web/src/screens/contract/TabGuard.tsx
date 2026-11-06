/**
 * Transaction guard — a controlled demonstration, labelled as one everywhere it appears.
 *
 * Monitoring tells you what the watcher last saw. It cannot stop a proxy being upgraded between
 * your review and your transaction. `ArgosGuard.checkAndCall` re-checks the implementation and
 * makes the call in the same transaction, then re-checks afterwards in case the call itself
 * upgraded the proxy. That requires a getter in the proxy's own code, which no ERC-7730 registry
 * contract has — so this works on one proxy Argos deployed on Sepolia and says UNSUPPORTED,
 * truthfully, for everything else.
 */
import { useState } from "react";
import { encodeFunctionData, isHex, parseAbi, type Hex } from "viem";
import { getAddress } from "viem";
import { GUARD_COPY, simulateGuard, type GuardSim } from "../../lib/guard.ts";
import { GUARD_DEMO } from "../../lib/config.ts";
import { routeLabel } from "../../lib/transport.ts";
import { contractHref } from "../../lib/router.ts";
import type { TabProps } from "./Workspace.tsx";
import {
  AddressLink, Badge, Callout, Card, CardHead, Compare, Tip, short, useTransport,
} from "../../components/common.tsx";
import { Icon } from "../../components/icons.tsx";

const EXAMPLES: { label: string; data: Hex }[] = [
  { label: "increment()", data: encodeFunctionData({ abi: parseAbi(["function increment()"]), args: [] }) },
  { label: "value() — view", data: encodeFunctionData({ abi: parseAbi(["function value() view returns (uint256)"]), args: [] }) },
];

export function TabGuard({ row }: TabProps) {
  const transport = useTransport();
  const [data, setData] = useState<string>(EXAMPLES[0]!.data);
  const [sim, setSim] = useState<GuardSim | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = isHex(data.trim()) && data.trim().length >= 10;

  async function run() {
    if (!valid) return;
    setBusy(true);
    const result = await simulateGuard(
      row.chainId,
      row.address,
      data.trim() as Hex,
      /^0x0{40}$/i.test(row.baseline.implementation) ? null : getAddress(row.baseline.implementation),
    );
    setSim(result);
    setBusy(false);
  }

  const copy = sim ? GUARD_COPY[sim.status] : null;

  return (
    <>
      <div className="banner b-exp">
        <span className="b-glyph"><Icon name="shield" size={21} /></span>
        <div className="stack-s" style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: "var(--s-3)" }}>
            <h2>Transaction guard</h2>
            <Badge tone="info" icon="spark">Experimental · controlled demonstration</Badge>
          </div>
          <p className="prose" style={{ maxWidth: "82ch" }}>
            This is a demonstration of a check-and-call flow on a proxy Argos deployed for the purpose. It is{" "}
            <b>not</b> universal protection for arbitrary contracts, and Argos does not offer it as such. The guard can
            only work where the proxy's own code exposes a trustworthy implementation getter.
          </p>
        </div>
      </div>

      {!row.guardable && (
        <Callout tone="warn">
          <b>This proxy does not expose the interface the guard needs.</b> Argos still monitors it and still warns when its
          code changes, but it cannot promise anything about the moment your transaction executes. The simulation below will
          report <span className="mono">UNSUPPORTED</span>, which is the honest answer for every ERC-7730 registry contract.
        </Callout>
      )}

      <Card>
        <CardHead
          title="Simulate a guarded call"
          sub="Read with eth_call through the guard's own wouldSucceed view. Nothing is sent and nothing is signed."
          icon="cpu"
          actions={
            <button className="btn primary sm" onClick={() => void run()} disabled={busy || !valid}>
              <Icon name="shieldCheck" size={13} /> {busy ? "Simulating…" : "Simulate"}
            </button>
          }
        />
        <div className="card-body stack">
          <div className="field">
            <label htmlFor="guard-data">Calldata to send through the guard</label>
            <textarea
              id="guard-data"
              className="input mono"
              value={data}
              spellCheck={false}
              aria-invalid={!valid}
              onChange={(e) => setData(e.target.value)}
              style={{ minHeight: 80 }}
            />
            {!valid ? (
              <span className="err"><Icon name="alert" size={12} /> Enter 0x-prefixed calldata with at least a 4-byte selector.</span>
            ) : (
              <span className="hint">Selector <span className="mono">{data.trim().slice(0, 10)}</span></span>
            )}
          </div>
          <div className="row">
            {EXAMPLES.map((x) => (
              <button key={x.label} className="btn sm" onClick={() => setData(x.data)}>{x.label}</button>
            ))}
          </div>
        </div>

        {sim && copy && (
          <>
            <Compare
              tone={copy.tone}
              glyph={sim.status === "VERIFIED" ? "check" : sim.status === "BLOCKED" ? "close" : sim.status === "UNSUPPORTED" ? "minus" : "question"}
              verdict={
                <>
                  <div className="eyebrow" style={{ color: "var(--ink-2)", letterSpacing: "0.07em" }}>{copy.label}</div>
                  <span className="asof">at block <b>{sim.block.toString()}</b></span>
                </>
              }
              left={{
                title: "Expected implementation",
                body: sim.expected ? (
                  <div className="big-addr"><AddressLink chainId={row.chainId} address={sim.expected} full /></div>
                ) : (
                  <div className="big-addr dim">no Argos baseline for this contract</div>
                ),
              }}
              right={{
                title: "Observed at execution",
                body: sim.actual ? (
                  <div className={`big-addr${sim.status === "BLOCKED" ? " is-bad" : ""}`}>
                    <AddressLink chainId={row.chainId} address={sim.actual} full tone={sim.status === "BLOCKED" ? "bad" : undefined} />
                  </div>
                ) : (
                  <div className="big-addr dim">{sim.status === "UNSUPPORTED" ? "no proxy-level getter to read" : "could not be established"}</div>
                ),
              }}
            />
            <div className="card-body" style={{ borderTop: "1px solid var(--hairline)" }}>
              <div className="stack">
                <p className="prose" style={{ color: "var(--ink)" }}>{copy.blurb}</p>
                {sim.error && <Callout tone="warn">{sim.error}</Callout>}
                <dl className="facts wide">
                  {sim.status !== "UNSUPPORTED" && (
                    <>
                      <dt>Send to</dt>
                      <dd><AddressLink chainId={GUARD_DEMO.chainId} address={GUARD_DEMO.guard} /> <span className="dim t-12">(ArgosGuard)</span></dd>
                    </>
                  )}
                  <dt>Target proxy</dt>
                  <dd><AddressLink chainId={row.chainId} address={row.address} /></dd>
                  <dt>
                    Outcome
                    <Tip text="VERIFIED: the implementation matches at execution. BLOCKED: it changed and the guarded call reverts. UNSUPPORTED: the proxy exposes no trustworthy getter. NOT VERIFIED: the implementation could not be established." />
                  </dt>
                  <dd><Badge tone={copy.tone} icon={sim.status === "VERIFIED" ? "check" : sim.status === "BLOCKED" ? "close" : "question"}>{copy.label}</Badge></dd>
                  <dt>Route</dt>
                  <dd className="t-13">{routeLabel(transport.mode)}</dd>
                </dl>
                {sim.guardedData && sim.status !== "UNSUPPORTED" && (
                  <div className="stack-s">
                    <span className="eyebrow">Guarded calldata · checkAndCall(proxy, expectedImplementation, data)</span>
                    <div className="hex">{sim.guardedData}</div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        <div className="card-foot">
          The simulation asks the deployed guard what it would do, rather than reimplementing the check here, so this panel
          cannot drift from what <span className="mono">checkAndCall</span> enforces on chain. It is still a preview: the
          implementation can change between this read and your transaction, which is exactly why the guard re-checks inside
          the transaction. The target sees the guard as <span className="mono">msg.sender</span>.
        </div>
      </Card>

      <Card>
        <CardHead title="What each outcome means" icon="info" />
        <div className="card-body">
          <div className="fact-grid">
            {(["VERIFIED", "BLOCKED", "UNSUPPORTED", "NOT_VERIFIED"] as const).map((s) => (
              <div className="fact" key={s}>
                <span className="f-k">
                  <Badge tone={GUARD_COPY[s].tone}>{GUARD_COPY[s].label}</Badge>
                </span>
                <span className="f-v dim" style={{ marginTop: 6 }}>{GUARD_COPY[s].blurb}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card-foot">
          Monitoring and transaction-time protection answer different questions. Monitoring is on the{" "}
          <a href={contractHref(row.chainId, row.address, "overview")}>Overview</a> tab and tells you what the watcher last
          saw; this tab tells you what would happen to a guarded transaction right now. Baseline implementation{" "}
          <span className="mono">{short(row.baseline.implementation, 10, 8)}</span>.
        </div>
      </Card>
    </>
  );
}
