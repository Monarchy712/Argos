/**
 * The contract's answer to "does what is deployed still match what I trusted?", using the
 * signature comparison rail: baseline left, observation right, verdict between them.
 */
import { useState } from "react";
import { PROXY_KINDS, type ProxyKind } from "@driftguard/core";
import { liveIdentity } from "../../lib/chain.ts";
import { routeLabel } from "../../lib/transport.ts";
import { contractHref } from "../../lib/router.ts";
import type { TabProps } from "./Workspace.tsx";
import {
  AddressLink, AsOf, Badge, Callout, Card, CardHead, Compare, Tip,
  ago, short, statusTone, useTransport,
} from "../../components/common.tsx";
import { Icon } from "../../components/icons.tsx";

type Live =
  | { state: "idle" }
  | { state: "running" }
  | { state: "ok"; identity: string; block: bigint; ms: number; matches: boolean; route: string }
  | { state: "failed"; error: string; route: string };

export function TabOverview({ row, now }: TabProps) {
  const transport = useTransport();
  const [live, setLive] = useState<Live>({ state: "idle" });
  const tone = statusTone(row.status.status);
  const supported = (PROXY_KINDS as readonly string[]).includes(row.proxyKind);
  const isDiamond = row.proxyKind === "diamond";

  async function checkNow() {
    const route = routeLabel(transport.mode);
    setLive({ state: "running" });
    try {
      const r = await liveIdentity(row.chainId, row.address as `0x${string}`, row.proxyKind as ProxyKind);
      setLive({
        state: "ok",
        identity: r.identityHash,
        block: r.block,
        ms: r.ms,
        matches: r.identityHash.toLowerCase() === row.baseline.codeIdentity.toLowerCase(),
        route,
      });
    } catch (err) {
      setLive({ state: "failed", error: (err instanceof Error ? err.message : String(err)).split("\n")[0]!, route });
    }
  }

  const verdict =
    row.status.status === "GREEN" ? {
      glyph: "check" as const,
      word: "Verified · no change",
      line: `The observed implementation matches the baseline as of block ${row.current?.checkedBlock ?? row.baseline.block}.`,
    } : row.status.status === "RED" ? {
      glyph: "alert" as const,
      word: "Change detected",
      line: `The observed implementation differs from the trusted baseline as of block ${row.current?.checkedBlock ?? row.change?.changeBlock ?? row.baseline.block}.`,
    } : {
      glyph: "question" as const,
      word: "Not verified",
      line: "Argos cannot currently establish the implementation state with sufficient confidence.",
    };

  return (
    <>
      <Card stripe={tone}>
        <CardHead
          title="Implementation comparison"
          sub="The trust anchor you approved, against what the watcher last read from the chain."
          actions={
            <button className="btn sm" onClick={() => void checkNow()} disabled={live.state === "running" || !supported}>
              <Icon name="refresh" size={13} /> {live.state === "running" ? "Reading…" : "Check now"}
            </button>
          }
        />

        <Compare
          tone={tone}
          glyph={verdict.glyph}
          verdict={
            <>
              <div className="eyebrow" style={{ color: "var(--ink-2)", letterSpacing: "0.07em" }}>{verdict.word}</div>
              <AsOf block={row.current?.checkedBlock ?? row.baseline.block} at={row.current?.checkedAt} now={now} />
            </>
          }
          left={{
            title: "Trusted baseline",
            body: (
              <div className="stack-s">
                {isDiamond ? (
                  <div className="big-addr dim">facets hash (diamond)</div>
                ) : (
                  <div className="big-addr">
                    <AddressLink chainId={row.chainId} address={row.baseline.implementation} full />
                  </div>
                )}
                <dl className="facts" style={{ marginTop: "var(--s-2)" }}>
                  <dt>Baseline block</dt>
                  <dd className="mono">{row.baseline.block.toString()}</dd>
                  <dt>Established</dt>
                  <dd className="mono">{new Date(row.baseline.baselinedAt * 1000).toISOString().replace("T", " ").slice(0, 19)}Z</dd>
                  <dt>Code identity</dt>
                  <dd className="mono" title={row.baseline.codeIdentity}>{short(row.baseline.codeIdentity, 14, 10)}</dd>
                  {row.baseline.reason && (<><dt>Reason</dt><dd>{row.baseline.reason}</dd></>)}
                </dl>
              </div>
            ),
          }}
          right={{
            title: "Currently observed",
            body: (
              <div className="stack-s">
                {!row.current ? (
                  <div className="big-addr" style={{ color: "var(--warn)" }}>No unexpired observation</div>
                ) : isDiamond ? (
                  <div className="big-addr dim">facets hash (diamond)</div>
                ) : (
                  <div className="big-addr">
                    <AddressLink
                      chainId={row.chainId}
                      address={row.current.implementation}
                      full
                      tone={row.current.matchesBaseline ? undefined : "bad"}
                    />
                  </div>
                )}
                <dl className="facts" style={{ marginTop: "var(--s-2)" }}>
                  <dt>Checked block</dt>
                  <dd className="mono">{row.current ? row.current.checkedBlock.toString() : "—"}</dd>
                  <dt>Checked at</dt>
                  <dd className="mono">{row.current ? `${ago(row.current.checkedAt, now)}` : "—"}</dd>
                  <dt>Code identity</dt>
                  <dd className="mono" title={row.current?.codeIdentity}>
                    {row.current ? short(row.current.codeIdentity, 14, 10) : "—"}
                  </dd>
                  <dt>Detection</dt>
                  <dd className="mono">{row.detection}</dd>
                </dl>
              </div>
            ),
          }}
        />

        <div className="card-body" style={{ borderTop: "1px solid var(--hairline)" }}>
          <div className="stack">
            <p className="prose" style={{ color: "var(--ink)" }}>{verdict.line}</p>
            <ul className="reasons">
              {row.status.reasons.map((x) => <li key={x}>{x}</li>)}
            </ul>
            {row.status.note && (
              <Callout tone="warn" icon="clock"><b>{row.status.note}</b> A return to the baseline implementation is still a change that happened.</Callout>
            )}
            {!supported && (
              <Callout tone="warn">
                This contract's upgrade mechanism is not one Argos can read (<span className="mono">{row.proxyKind}</span>),
                so a change cannot be detected for it. It is shown as Not verified rather than assumed unchanged.
              </Callout>
            )}
          </div>
        </div>

        {live.state !== "idle" && (
          <div className="card-foot" style={{ color: "var(--ink-2)" }}>
            {live.state === "running" && <>Reading the proxy slots {routeLabel(transport.mode)}…</>}
            {live.state === "failed" && (
              <span style={{ color: "var(--warn)" }}>
                Live read failed {live.route}: {live.error}. The watcher record above is unaffected.
              </span>
            )}
            {live.state === "ok" && (
              <>
                <b style={{ color: live.matches ? "var(--ok)" : "var(--bad)" }}>
                  {live.matches ? "Your own live read matches the baseline" : "Your own live read differs from the baseline"}
                </b>{" "}
                at block <span className="mono">{live.block.toString()}</span> · {live.ms} ms · {live.route} · identity{" "}
                <span className="mono">{short(live.identity, 12, 8)}</span>. This is an observation at that block, not a
                statement about later blocks.
              </>
            )}
          </div>
        )}
      </Card>

      <div className="stack" style={{ gridTemplateColumns: "minmax(0,1fr)", display: "grid" }}>
        <Card>
          <CardHead
            title="What to do next"
            sub="Each route stays inside this contract."
            icon="arrowRight"
          />
          <div className="card-body">
            <div className="fact-grid">
              <NextStep
                href={contractHref(row.chainId, row.address, "history")}
                icon="clock"
                title="Changes & history"
                body="Baseline, changes, explanations and monitoring gaps for this contract, newest first."
              />
              <NextStep
                href={contractHref(row.chainId, row.address, "investigate")}
                icon="alert"
                title="Investigate the change"
                body={row.change ? "Selectors that moved, the upgrade transaction and the model's description of the diff." : "No implementation change is recorded since the baseline."}
                disabled={!row.change}
              />
              <NextStep
                href={contractHref(row.chainId, row.address, "evidence")}
                icon="database"
                title="Evidence & provenance"
                body="The Arkiv records, Swarm content and hashes every claim on this page rests on."
              />
              <NextStep
                href={contractHref(row.chainId, row.address, "guard")}
                icon="shield"
                title="Transaction guard"
                body={row.guardable ? "Controlled demonstration of a check-and-call flow for this proxy." : "Not available for this proxy architecture."}
              />
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHead title="Descriptor" sub="What a wallet would show a user signing a transaction to this address." icon="file" />
        <div className="card-body">
          {row.descriptorPath ? (
            <dl className="facts wide">
              <dt>Registry file</dt>
              <dd className="mono">{row.descriptorPath.replace(/^registry\//, "")}</dd>
              <dt>
                ERC-8176 hash
                <Tip text="A hash over the resolved descriptor. Argos re-computes it from the bytes it downloads and refuses to render anything that does not match." />
              </dt>
              <dd className="mono" title={row.descriptorHash ?? ""}>{row.descriptorHash ? short(row.descriptorHash, 16, 10) : "—"}</dd>
              <dt>Attestation</dt>
              <dd>{row.attested ? <Badge tone="info" icon="file">Auditor attestation signs this descriptor</Badge> : <span className="dim">none in the registry</span>}</dd>
            </dl>
          ) : (
            <p className="prose">
              The ERC-7730 registry mirror has no calldata descriptor for this address, so a wallet has nothing to render a
              readable intent from. Argos still monitors the code behind it.
            </p>
          )}
        </div>
        <div className="card-foot">
          Full descriptor provenance, including the Swarm reference and every hash check, is on the{" "}
          <a href={contractHref(row.chainId, row.address, "evidence")}>Evidence</a> tab.
        </div>
      </Card>
    </>
  );
}

function NextStep({ href, icon, title, body, disabled }: { href: string; icon: Parameters<typeof Icon>[0]["name"]; title: string; body: string; disabled?: boolean }) {
  const inner = (
    <>
      <div className="row" style={{ gap: 8 }}>
        <Icon name={icon} size={15} style={{ color: disabled ? "var(--ink-3)" : "var(--accent)" }} />
        <span className="strong t-13">{title}</span>
      </div>
      <p className="t-12 dim" style={{ marginTop: 4, lineHeight: 1.55 }}>{body}</p>
    </>
  );
  return disabled ? (
    <div className="flow-node" style={{ display: "block", opacity: 0.55 }}>{inner}</div>
  ) : (
    <a className="flow-node" href={href} style={{ display: "block", textDecoration: "none", color: "inherit" }}>{inner}</a>
  );
}
