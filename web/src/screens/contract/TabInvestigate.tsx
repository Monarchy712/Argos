/**
 * Investigating one implementation change.
 *
 * Three different kinds of claim appear on this page and they are never blended:
 *   - OBSERVED   what the watcher recorded on Arkiv (addresses, blocks, the upgrade transaction).
 *   - DERIVED    the selector diff, computed here from the deployed bytecode of both
 *                implementations. A PUSH4 scan is a superset of the ABI, and the panel says so.
 *   - DESCRIBED  the model's sentences from 0G, fetched from Swarm and rendered only if they hash
 *                to the value published on Arkiv.
 *
 * Nothing on this page calls a change safe or malicious, because Argos cannot know that.
 */
import { useEffect, useState } from "react";
import { diffSelectors, selectorsFromBytecode, withoutErrorSelectors, type Selector, type SelectorDiff } from "@driftguard/core";
import { isAddress, type Address } from "viem";
import { clientFor } from "../../lib/chain.ts";
import { fetchChangeNote, type ChangeNoteText } from "../../lib/changeNote.ts";
import { contractHref } from "../../lib/router.ts";
import { routeLabel } from "../../lib/transport.ts";
import type { TabProps } from "./Workspace.tsx";
import {
  AddressLink, AiNote, ArkivLink, AsOf, Badge, Callout, Card, CardHead, Compare, Empty,
  Skeleton, SwarmLink, Tip, TxLink, ago, short, useTransport,
} from "../../components/common.tsx";
import { Icon } from "../../components/icons.tsx";

type DiffState =
  | { state: "idle" }
  | { state: "running" }
  | { state: "ok"; diff: SelectorDiff; route: string }
  | { state: "failed"; error: string; route: string };

export function TabInvestigate({ row, now }: TabProps) {
  const transport = useTransport();
  const change = row.change;
  const note = row.changeNote;
  const [diff, setDiff] = useState<DiffState>({ state: "idle" });
  const [text, setText] = useState<ChangeNoteText | null>(null);

  const prev = change?.previousValue ?? "";
  const next = change?.newValue ?? "";
  const comparable = isAddress(prev) && isAddress(next);

  // A recorded change is not automatically an open finding. It is live only while the contract
  // actually differs from its baseline; a change that predates the current baseline was
  // superseded by a rebaseline, and an A→B→A return matches again. Presenting either as an active
  // incident would contradict the VERIFIED badge in the workspace header.
  const live = row.status.status === "RED";
  const superseded = !!change && change.changeBlock < row.baseline.block;

  // The model's words: fetched from Swarm, rendered only if they hash to what Arkiv publishes.
  useEffect(() => {
    if (!note) return;
    let live = true;
    setText(null);
    void fetchChangeNote(note.summarySwarmRef, note.summaryHash).then((t) => live && setText(t));
    return () => { live = false; };
  }, [note?.summarySwarmRef, note?.summaryHash]);

  async function readSelectors() {
    if (!comparable) return;
    const route = routeLabel(transport.mode);
    setDiff({ state: "running" });
    try {
      const client = clientFor(row.chainId);
      const [before, after] = await Promise.all([
        client.getCode({ address: prev as Address }),
        client.getCode({ address: next as Address }),
      ]);
      setDiff({
        state: "ok",
        route,
        diff: diffSelectors(
          withoutErrorSelectors(selectorsFromBytecode(before ?? "0x")),
          withoutErrorSelectors(selectorsFromBytecode(after ?? "0x")),
        ),
      });
    } catch (err) {
      setDiff({ state: "failed", error: (err instanceof Error ? err.message : String(err)).split("\n")[0]!, route });
    }
  }

  if (!change) {
    return (
      <Card>
        <Empty
          icon="shieldCheck"
          title="No implementation change recorded"
          action={
            <div className="row">
              <a className="btn" href={contractHref(row.chainId, row.address, "history")}>View history</a>
              <a className="btn" href={contractHref(row.chainId, row.address, "overview")}>Back to overview</a>
            </div>
          }
        >
          Argos has not recorded a change from the baseline for this contract. If a change is detected later, it will
          appear here with the upgrade transaction, the selector diff and a description of what moved.
        </Empty>
      </Card>
    );
  }

  return (
    <>
      <div className={`banner${live ? "" : " b-warn"}`}>
        <span className="b-glyph"><Icon name={live ? "alert" : "clock"} size={21} /></span>
        <div className="stack-s" style={{ flex: 1, minWidth: 0 }}>
          <h2>{live ? "Implementation change detected" : "Recorded implementation change"}</h2>
          <p className="prose" style={{ color: "var(--ink-2)", maxWidth: "80ch" }}>
            {live ? (
              <>
                The code behind this address is no longer the code recorded at your baseline. An upgrade is a normal
                operation and is <b>not</b> evidence of wrongdoing — Argos reports that it happened and gives you the
                evidence to judge it.
              </>
            ) : superseded ? (
              <>
                This change happened at block <b>{change.changeBlock.toString()}</b>, <b>before</b> the baseline you are
                currently monitoring against (block {row.baseline.block.toString()}). It is kept here as history: the
                contract matches its current baseline, so it is not an open finding.
              </>
            ) : (
              <>
                The contract matched its baseline at its last check, but this change was observed since the baseline was
                established. A return to the baseline implementation is still a change that happened, so Argos keeps it
                visible rather than clearing it.
              </>
            )}
          </p>
          <div className="row" style={{ marginTop: 4 }}>
            <Badge tone={live ? "bad" : "warn"} icon={live ? "alert" : "clock"} large>
              {live ? "Change detected" : superseded ? "Superseded by a later baseline" : "Resolved · returned to baseline"}
            </Badge>
            <AsOf block={change.changeBlock} at={change.detectedAt} now={now} prefix="detected at" />
          </div>
        </div>
      </div>

      {/* ---------- observed facts, in the same rail used everywhere else ---------- */}
      <Card stripe={live ? "bad" : "warn"}>
        <CardHead title="What changed" sub="Recorded by the Argos watcher and published on Arkiv." icon="layers" />
        <Compare
          tone={live ? "bad" : "warn"}
          glyph="arrowRight"
          verdict={
            <>
              <div className="eyebrow" style={{ color: live ? "var(--bad)" : "var(--warn)", letterSpacing: "0.07em" }}>{change.field}</div>
              <AsOf block={change.changeBlock} prefix="at" />
            </>
          }
          left={{
            title: "Previous implementation",
            body: (
              <div className="big-addr">
                <AddressLink chainId={row.chainId} address={prev} full />
              </div>
            ),
          }}
          right={{
            title: "New implementation",
            body: (
              <div className={`big-addr${live ? " is-bad" : ""}`}>
                <AddressLink chainId={row.chainId} address={next} full tone={live ? "bad" : undefined} />
              </div>
            ),
          }}
        />
        <div className="card-body" style={{ borderTop: "1px solid var(--hairline)" }}>
          <dl className="facts wide">
            <dt>Detection block</dt>
            <dd className="mono">{change.changeBlock.toString()}</dd>
            <dt>Upgrade transaction</dt>
            <dd><TxLink chainId={row.chainId} tx={change.txHash} /></dd>
            <dt>Detected at</dt>
            <dd className="mono">
              {new Date(change.detectedAt * 1000).toISOString().replace("T", " ").slice(0, 19)}Z · {ago(change.detectedAt, now)}
            </dd>
            <dt>
              Detected by
              <Tip text="event: an Upgraded/BeaconUpgraded/DiamondCut log was scanned. slot: the watcher's periodic read of the EIP-1967 slots saw a different value." />
            </dt>
            <dd className="mono">{change.detectedBy}</dd>
            <dt>{superseded ? "Baseline now in force" : "Baseline it departed from"}</dt>
            <dd>
              <AddressLink chainId={row.chainId} address={row.baseline.implementation} />{" "}
              <span className="dim t-12">
                at block {row.baseline.block.toString()}{superseded ? " — established after this change" : ""}
              </span>
            </dd>
          </dl>
        </div>
      </Card>

      {/* ---------- derived: the selector diff ---------- */}
      <Card>
        <CardHead
          title="Function selectors"
          sub="Derived here by scanning the deployed bytecode of both implementations."
          icon="cpu"
          actions={
            <button className="btn sm" onClick={() => void readSelectors()} disabled={diff.state === "running" || !comparable}>
              <Icon name="refresh" size={13} /> {diff.state === "running" ? "Reading bytecode…" : diff.state === "ok" ? "Re-read" : "Compare selectors"}
            </button>
          }
        />
        <div className="card-body stack">
          {!comparable ? (
            <Callout tone="warn">
              This change is on <span className="mono">{change.field}</span>, whose values are not two implementation
              addresses, so there is no bytecode pair to compare.
            </Callout>
          ) : diff.state === "idle" ? (
            <p className="prose">
              Argos can read the deployed bytecode of both implementations and compare the 4-byte values their dispatchers
              push. Nothing is sent: these are <span className="mono">eth_getCode</span> reads, routed{" "}
              {routeLabel(transport.mode)}.
            </p>
          ) : diff.state === "running" ? (
            <Skeleton lines={3} />
          ) : diff.state === "failed" ? (
            <Callout tone="warn">Could not read bytecode {diff.route}: {diff.error}</Callout>
          ) : (
            <SelectorDiffView diff={diff.diff} route={diff.route} />
          )}

          {note && (
            <Callout tone="info" icon="database">
              The watcher's own comparison, published on Arkiv when the change was detected:{" "}
              {note.sameSurface
                ? <><b>same call surface</b> — the same selectors, different code.</>
                : <><b>{note.selectorsAdded} added, {note.selectorsRemoved} removed</b>.</>}
            </Callout>
          )}
        </div>
        <div className="card-foot">
          A PUSH4 scan is a heuristic, not a decompiler: it is a superset of the external ABI. It can include constants that
          are not selectors, and it misses assembly dispatchers and fallback-only contracts. Read it as "4-byte values the
          bytecode pushes", never as the contract's ABI.
        </div>
      </Card>

      {/* ---------- described: the model ---------- */}
      <Card>
        <CardHead
          title="Understanding this change"
          sub="A description of what moved, not an assessment of whether it is safe."
          icon="spark"
          actions={note ? <Badge tone="info" icon="cpu">0G · {note.model}</Badge> : undefined}
        />
        <div className="card-body">
          {!note ? (
            <Empty icon="spark" title="No explanation has been generated">
              Argos records change explanations as <span className="mono">dg_change_note</span> rows written after a change
              is detected. None exists for this contract yet, so there is nothing to verify or display.
            </Empty>
          ) : (
            <>
              <div className="ai-sec">
                <h4>Summary of observed changes</h4>
                {text === null && <Skeleton lines={2} />}
                {text?.state === "ok" && <p className="prose">{text.text}</p>}
                {text?.state === "mismatch" && (
                  <Callout tone="bad">
                    <b>Description rejected: integrity check failed.</b> Swarm returned bytes hashing to{" "}
                    <span className="mono">{short(text.got, 12, 8)}</span>, but Arkiv publishes{" "}
                    <span className="mono">{short(text.expected, 12, 8)}</span>. Argos renders nothing from it — an
                    unverified sentence about what changed is worth less than no sentence at all.
                  </Callout>
                )}
                {text?.state === "unavailable" && (
                  <Callout tone="warn">
                    Swarm could not serve the description ({text.error}). The change itself is recorded above and is
                    unaffected.
                  </Callout>
                )}
              </div>

              <div className="ai-sec">
                <h4>Functions affected</h4>
                {note.sameSurface ? (
                  <p className="prose">
                    The call surface is <b>unchanged</b>: both implementations expose the same selectors. This is the case
                    that matters most for clear signing — a wallet will keep rendering the same readable intent from the
                    same descriptor, while different code runs behind it. Identical surface is not identical behaviour.
                  </p>
                ) : (
                  <p className="prose">
                    The watcher recorded <b>{note.selectorsAdded}</b> selector{note.selectorsAdded === 1 ? "" : "s"} added and{" "}
                    <b>{note.selectorsRemoved}</b> removed. Use the comparison above to see which, read live from bytecode.
                  </p>
                )}
              </div>

              <div className="ai-sec">
                <h4>Potential implications to investigate</h4>
                <ul className="reasons">
                  <li>
                    The ERC-7730 descriptor for this address is bound to the proxy, not the implementation. Check whether it
                    still describes the code that runs now.
                  </li>
                  {note.sameSurface ? (
                    <li>Because the selectors are identical, nothing in a wallet's UI would look different after this upgrade.</li>
                  ) : (
                    <li>Selectors the descriptor documents may have been removed, or new entry points added that it does not cover.</li>
                  )}
                  <li>Whoever can perform this upgrade can perform another one at any later block, including after you review it.</li>
                </ul>
              </div>

              <div className="ai-sec">
                <h4>What to investigate next</h4>
                <ul className="reasons">
                  <li>Read the upgrade transaction and confirm the caller is the governance path you expect for this protocol.</li>
                  <li>Compare the new implementation's verified source, if it is published, against the previous one.</li>
                  <li>Check whether the protocol announced this upgrade through its own channels.</li>
                  <li>
                    If you are about to sign a transaction to this address, consider whether the implementation can change again
                    between your review and execution — see the{" "}
                    <a href={contractHref(row.chainId, row.address, "guard")}>Transaction Guard</a> tab.
                  </li>
                </ul>
              </div>
            </>
          )}
        </div>
        <AiNote />
        {note && (
          <div className="card-foot">
            <div className="row" style={{ gap: "var(--s-4)" }}>
              <span>Model <span className="mono">{note.model}</span></span>
              <span>0G request <span className="mono">{note.requestId || "—"}</span></span>
              <span>Cost {note.costUsdMicro ? `$${(note.costUsdMicro / 1_000_000).toFixed(6)}` : "—"}</span>
              <span>Generated {ago(note.generatedAt, now)}</span>
            </div>
          </div>
        )}
      </Card>

      {/* ---------- evidence for this event specifically ---------- */}
      <Card>
        <CardHead title="Evidence for this change" sub="The records behind every claim above." icon="database" />
        <div className="evidence">
          <EvRow k="Upgrade transaction" v={change.txHash || "found by slot read (no transaction)"}>
            {change.txHash && <TxLink chainId={row.chainId} tx={change.txHash} />}
          </EvRow>
          <EvRow k="Detection block" v={change.changeBlock.toString()} />
          <EvRow k="Arkiv · latest change" v={change.key}>
            <ArkivLink entityKey={change.key} label="dg_latest_change" />
          </EvRow>
          <EvRow k="Arkiv · baseline" v={row.baseline.key}>
            <ArkivLink entityKey={row.baseline.key} label="dg_baseline" />
          </EvRow>
          {note && (
            <>
              <EvRow k="Arkiv · change note" v={note.key}>
                <ArkivLink entityKey={note.key} label="dg_change_note" />
              </EvRow>
              <EvRow k="Swarm · explanation text" v={note.summarySwarmRef}>
                <SwarmLink swarmRef={note.summarySwarmRef} />
              </EvRow>
              <EvRow k="Explanation hash" v={note.summaryHash}>
                <Badge tone={text?.state === "ok" ? "ok" : text?.state === "mismatch" ? "bad" : "warn"} icon={text?.state === "ok" ? "check" : "question"}>
                  {text?.state === "ok" ? "Hash verified" : text?.state === "mismatch" ? "Hash mismatch" : "Not verified"}
                </Badge>
              </EvRow>
            </>
          )}
        </div>
        <div className="card-foot">
          Full provenance for the contract, including descriptor hashes and the registry mirror, is on the{" "}
          <a href={contractHref(row.chainId, row.address, "evidence")}>Evidence</a> tab.
        </div>
      </Card>
    </>
  );
}

function SelectorDiffView({ diff, route }: { diff: SelectorDiff; route: string }) {
  const unchanged = diff.added.length === 0 && diff.removed.length === 0;
  return (
    <div className="stack">
      <div className="row" style={{ gap: "var(--s-3)" }}>
        <Badge tone="ok" icon="add">{diff.added.length} added</Badge>
        <Badge tone="bad" icon="minus">{diff.removed.length} removed</Badge>
        <Badge icon="check">{diff.kept.length} kept</Badge>
        <span className="asof">read {route}</span>
      </div>

      {unchanged ? (
        <Callout tone="warn" icon="alert">
          <b>Same call surface, different code.</b> Both implementations push exactly the same 4-byte values, so nothing a
          wallet shows would look different — and the descriptor bound to this proxy still appears to match. The code behind
          it is not the code that was reviewed.
        </Callout>
      ) : (
        <>
          {diff.added.length > 0 && <SelGroup title="Added in the new implementation" cls="add" op="+" items={diff.added} />}
          {diff.removed.length > 0 && <SelGroup title="Removed from the previous implementation" cls="rem" op="−" items={diff.removed} />}
        </>
      )}

      {diff.kept.length > 0 && (
        <details className="disclose">
          <summary>
            <Icon name="chevronRight" size={13} className="chev" />
            {diff.kept.length} selectors present in both
          </summary>
          <div className="d-body">
            <div className="sel-list">
              {diff.kept.map((s) => <span className="sel" key={s}><span className="op">=</span><span className="mono">{s}</span></span>)}
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

function SelGroup({ title, cls, op, items }: { title: string; cls: string; op: string; items: readonly Selector[] }) {
  return (
    <div className="stack-s">
      <span className="eyebrow">{title}</span>
      <div className="sel-list">
        {items.map((s) => (
          <span className={`sel ${cls}`} key={s}>
            <span className="op">{op}</span>
            <span className="mono">{s}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function EvRow({ k, v, children }: { k: string; v: string; children?: React.ReactNode }) {
  return (
    <div className="ev-row">
      <span className="ev-k">{k}</span>
      <span className="ev-v">{v}</span>
      <span>{children}</span>
    </div>
  );
}
