/**
 * Add a contract — the guided baseline journey.
 *
 * The honest shape of this flow is dictated by the architecture: the browser holds no key, so it
 * cannot publish a `dg_baseline` row (those are written with ARKIV_WRITER_PRIVATE_KEY by the
 * watcher/importer). Everything up to the decision is real work done here — a live slot read, the
 * registry mirror lookup, a hash-checked descriptor fetch — and the last step says plainly who
 * publishes the record and what it will contain. No step claims an audit, a score, or a
 * certification, because Argos has none to give.
 */
import { Fragment, useState } from "react";
import { codeIdentityHash, inspectContract, readIdentity, type CodeIdentity, type Inspection } from "@driftguard/core";
import { getAddress, isAddress, type Address } from "viem";
import { clientFor } from "../lib/chain.ts";
import { ARKIV_EXPLORER, CHAINS } from "../lib/config.ts";
import { architectureLabel, failureOutcome, outcomeOf, type Outcome } from "../lib/inspection.ts";
import { lookupContract, type ContractLookup } from "../lib/mirror.ts";
import { RegistryFallbackSource, SwarmFirstSource, type FetchRecord, type RegistryManifest } from "../lib/descriptors.ts";
import { pendingStore, type PendingStatus } from "../lib/pending.ts";
import { publishBaseline as publish, publishHeadline, type PublishState } from "../lib/publish.ts";
import { contractHref, navigate } from "../lib/router.ts";
import { routeLabel } from "../lib/transport.ts";
import type { ArkivState, MonitoredRow } from "../lib/rows.ts";
import { PageHead } from "../components/Shell.tsx";
import {
  AddressLink, Badge, Callout, Card, CardHead, Skeleton, SwarmLink, Tip,
  chainName, short, toast, useTransport,
} from "../components/common.tsx";
import { Icon } from "../components/icons.tsx";

type Step = 1 | 2 | 3 | 4;

interface Inspected {
  chainId: number;
  address: Address;
  block: bigint;
  /** What the slot probes concluded, and why. */
  result: Inspection;
  outcome: Outcome;
  /** Null when the architecture has no identity Argos can read (unsupported, delegated, no code). */
  identity: CodeIdentity | null;
  identityHash: `0x${string}` | null;
  lookup: ContractLookup | null;
  lookupError: string | null;
  descriptorCheck: { state: "none" } | { state: "ok"; log: FetchRecord[] } | { state: "failed"; error: string; log: FetchRecord[] };
  route: string;
  ms: number;
}

const STEPS: { n: Step; k: string; v: string }[] = [
  { n: 1, k: "Step 1", v: "Identify contract" },
  { n: 2, k: "Step 2", v: "Contract inspection" },
  { n: 3, k: "Step 3", v: "Establish trust baseline" },
  { n: 4, k: "Step 4", v: "Monitoring" },
];

export function AddContractScreen({ rows, manifest, arkiv }: { rows: MonitoredRow[]; manifest: RegistryManifest | null; arkiv: ArkivState }) {
  const transport = useTransport();
  const [step, setStep] = useState<Step>(1);
  const [chainId, setChainId] = useState<number>(1);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  /** An inspection that did not complete. Kept apart from a completed one so it can never read as a verdict. */
  const [failure, setFailure] = useState<Outcome | null>(null);
  const [ins, setIns] = useState<Inspected | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  /** What the server actually did with the request. Null until step 4 begins. */
  const [published, setPublished] = useState<PublishState | null>(null);

  const trimmed = address.trim();
  const validAddress = isAddress(trimmed);
  const already = validAddress ? rows.find((r) => r.chainId === chainId && r.address.toLowerCase() === trimmed.toLowerCase()) ?? null : null;

  async function inspect() {
    if (!validAddress) return;
    setFailure(null);
    setBusy(true);
    const t0 = performance.now();
    const route = routeLabel(transport.mode);
    const addr = getAddress(trimmed);
    try {
      const client = clientFor(chainId);
      const block = (await client.getBlockNumber()) - 2n;
      // Throws InspectionError if a probe could not be run, so an RPC failure is never reported
      // as "not a proxy" — see lib/inspection.ts.
      const result = await inspectContract(client, addr, block);
      const outcome = outcomeOf(result);

      // Only read a code identity for architectures the watcher can actually monitor. For the
      // rest there is nothing to baseline, and inventing a zero identity would make every later
      // read look like a change.
      const identity = result.monitorAs ? await readIdentity(client, addr, result.monitorAs, block) : null;

      // Registry evidence (bulk mirror read, contract-independent where the budget allows it).
      let lookup: ContractLookup | null = null;
      let lookupError: string | null = null;
      try {
        lookup = await lookupContract(chainId, addr);
      } catch (err) {
        lookupError = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      }

      // If a descriptor exists, actually fetch and hash-check it rather than claiming it is fine.
      let descriptorCheck: Inspected["descriptorCheck"] = { state: "none" };
      const index = lookup?.manifest ?? manifest;
      const path = lookup?.descriptor?.path ?? null;
      if (index && path) {
        const source = index.swarm && Object.keys(index.swarm).length > 0 ? new SwarmFirstSource(index) : new RegistryFallbackSource(index);
        try {
          await source.fetchDescriptor(path);
          descriptorCheck = { state: "ok", log: [...source.log] };
        } catch (err) {
          descriptorCheck = { state: "failed", error: err instanceof Error ? err.message.split("\n")[0]! : String(err), log: [...source.log] };
        }
      }

      setIns({
        chainId, address: addr, block, result, outcome, identity,
        identityHash: identity ? codeIdentityHash(identity) : null,
        lookup, lookupError, descriptorCheck, route,
        ms: Math.round(performance.now() - t0),
      });
      setStep(2);
    } catch (err) {
      setFailure(failureOutcome(err));
    } finally {
      setBusy(false);
    }
  }

  /** Maps a publish outcome onto the local receipt's status. */
  const PENDING_STATUS: Record<PublishState["state"], PendingStatus> = {
    "no-publisher": "needs-publisher",
    publishing: "publishing",
    published: "published",
    "already-monitored": "published",
    rejected: "refused",
    blocked: "blocked",
    unverified: "unconfirmed",
    failed: "failed",
  };

  /**
   * Asks the server to publish the baseline, then shows what actually happened.
   *
   * The browser cannot sign a `dg_baseline` row — the writer key is server-side and stays there —
   * so this posts the person's decision and waits for the server to publish and read the row
   * back. Only a `published` answer means the contract is monitored, and step 4 says which of the
   * outcomes it was rather than one catch-all "awaiting publication".
   */
  async function establish() {
    // No readable identity means there is nothing to compare future reads against, so there is
    // no baseline to request. The UI does not offer the button in that case; this is the guard.
    if (!ins || !confirmed || !ins.identity || !ins.identityHash) return;
    const receipt = {
      chainId: ins.chainId,
      address: ins.address,
      proxyKind: ins.identity.proxyKind,
      implementation: ins.identity.implementation,
      codeIdentity: ins.identityHash,
      observedBlock: ins.block.toString(),
      observedAt: Math.floor(Date.now() / 1000),
      descriptorPath: ins.lookup?.descriptor?.path ?? null,
      descriptorHash: ins.lookup?.descriptor?.descriptorHash ?? null,
      label: ins.lookup?.descriptor?.owner || ins.lookup?.descriptor?.entity || short(ins.address, 8, 6),
      updatedAt: Math.floor(Date.now() / 1000),
    };

    setPublished({ state: "publishing" });
    setStep(4);
    pendingStore.upsert({ ...receipt, status: "publishing", detail: "Asking the Argos publisher to write the baseline." });

    const result = await publish({ chainId: ins.chainId, address: ins.address, reason: "baselined by a reviewer in the Argos web app" });
    setPublished(result);
    const detail =
      result.state === "published" ? `Published as Arkiv entity ${result.entityKey} and read back.`
      : result.state === "already-monitored" ? `A baseline already existed (${result.entityKey}); this request changed nothing.`
      : result.state === "no-publisher" ? "This build has no publisher configured, so the request was not sent anywhere."
      : "message" in result ? result.message
      : "";
    pendingStore.setStatus(ins.chainId, ins.address, PENDING_STATUS[result.state], detail, "entityKey" in result ? result.entityKey : undefined);

    if (result.state === "published" || result.state === "already-monitored") {
      toast(result.state === "published" ? "Baseline published on Arkiv" : "Already monitored");
      // The watcher reads baselines at the top of each cycle, so the Arkiv snapshot will carry
      // this contract shortly. Refreshing makes it appear in My Contracts without a reload.
      void arkiv.refresh();
    }
  }

  function restart() {
    setStep(1); setIns(null); setConfirmed(false); setFailure(null); setAddress(""); setPublished(null);
  }

  return (
    <div className="page">
      <PageHead
        eyebrow={`Step ${step} of 4`}
        title="Add a contract"
        sub="Argos inspects the contract, shows you the evidence it can gather, and then asks you to decide. The first implementation Argos observes is not automatically trustworthy, and Argos will not decide for you."
      />

      <Card>
        <div className="stepper">
          {STEPS.map((s) => (
            <div key={s.n} className={`step${step > s.n ? " is-done" : step === s.n ? " is-now" : ""}`}>
              <span className="num">{step > s.n ? <Icon name="check" size={13} /> : s.n}</span>
              <span className="lines">
                <span className="s-k">{s.k}</span>
                <span className="s-v">{s.v}</span>
              </span>
            </div>
          ))}
        </div>
      </Card>

      {step === 1 && (
        <Card>
          <CardHead title="Identify the contract" sub="The address a wallet would send a transaction to — the proxy, not the implementation." icon="contracts" />
          <div className="card-body stack">
            <div className="fact-grid" style={{ gridTemplateColumns: "200px minmax(0, 1fr)" }}>
              <div className="field">
                <label htmlFor="net">Network</label>
                <select id="net" className="select" value={chainId} onChange={(e) => setChainId(Number(e.target.value))}>
                  {Object.values(CHAINS).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="addr">Proxy contract address</label>
                <input
                  id="addr"
                  className="input mono"
                  value={address}
                  placeholder="0x…"
                  spellCheck={false}
                  aria-invalid={trimmed.length > 0 && !validAddress}
                  onChange={(e) => setAddress(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && validAddress && void inspect()}
                />
                {trimmed.length > 0 && !validAddress && (
                  <span className="err"><Icon name="alert" size={12} /> That is not a 20-byte hex address.</span>
                )}
              </div>
            </div>

            {already && (
              <Callout tone="info">
                <b>Argos already monitors this contract.</b>{" "}
                <a href={contractHref(already.chainId, already.address)}>Open {already.protocol}</a> to see its baseline and
                current status instead of establishing a new one.
              </Callout>
            )}
            {failure && (
              <Callout tone={failure.tone === "neutral" ? "info" : failure.tone}>
                <b>{failure.label}.</b> {failure.detail}
              </Callout>
            )}

            <div className="row">
              <button className="btn primary" onClick={() => void inspect()} disabled={!validAddress || busy}>
                <Icon name="search" size={14} /> {busy ? "Inspecting…" : "Inspect contract"}
              </button>
              <span className="asof">reads go {routeLabel(transport.mode)}</span>
            </div>
            {busy && <Skeleton lines={3} />}
          </div>
          <div className="card-foot">
            Inspection is read-only: proxy slots over <span className="mono">eth_getStorageAt</span>, a registry lookup on
            Arkiv, and a descriptor fetch that is checked against its published hash. Nothing is signed and nothing is sent.
          </div>
        </Card>
      )}

      {step >= 2 && ins && (
        <Card stripe={ins.outcome.monitorable ? "info" : "warn"}>
          <CardHead
            title="Contract inspection"
            sub={`Read at block ${ins.block} in ${ins.ms} ms, ${ins.route}.`}
            icon="search"
            actions={step === 2 ? <button className="btn sm ghost" onClick={restart}>Start over</button> : undefined}
          />
          <div className="card-body stack">
            <dl className="facts wide">
              <dt>
                Inspection result
                <Tip text="Argos probes, in order: the EIP-1967 implementation and beacon slots, the pre-EIP-1967 OpenZeppelin slot, the EIP-2535 diamond loupe, the canonical EIP-1167 clone runtime, and the Safe singleton slot. A pattern it cannot read is reported as an unsupported proxy, and a probe that fails is reported as an error — never as 'not a proxy'." />
              </dt>
              <dd>
                <Badge tone={ins.outcome.tone} icon="layers">{ins.outcome.label}</Badge>{" "}
                <span className="dim t-12">{architectureLabel(ins.result.architecture)}</span>
              </dd>

              <dt>Current implementation</dt>
              <dd>
                {/^0x0{40}$/i.test(ins.result.implementation)
                  ? <span className="dim">{ins.result.architecture === "diamond" ? "diamond — identity is a hash over facets" : "none readable"}</span>
                  : <AddressLink chainId={ins.chainId} address={ins.result.implementation} full />}
              </dd>

              <dt>Code identity</dt>
              <dd className="mono" title={ins.identityHash ?? undefined}>
                {ins.identityHash ? short(ins.identityHash, 18, 12) : <span className="dim">none — Argos cannot read what code runs here</span>}
              </dd>

              <dt>Latest observed block</dt>
              <dd className="mono">{ins.block.toString()}</dd>

              <dt>Deployed code</dt>
              <dd className="mono">{ins.result.codeSize.toLocaleString()} bytes</dd>

              <dt>In the ERC-7730 registry</dt>
              <dd>
                {ins.lookupError ? (
                  <Badge tone="warn" icon="question">registry mirror unreachable</Badge>
                ) : ins.lookup?.deployment ? (
                  <Badge tone="ok" icon="check">yes — registered deployment</Badge>
                ) : (
                  <Badge icon="minus">no entry for this address</Badge>
                )}
              </dd>

              <dt>Descriptor available</dt>
              <dd>
                {ins.lookup?.descriptor ? (
                  <span className="mono t-12">{ins.lookup.descriptor.path}</span>
                ) : (
                  <span className="dim">none — a wallet has nothing to render a readable intent from</span>
                )}
              </dd>

              <dt>Descriptor verification</dt>
              <dd>
                {ins.descriptorCheck.state === "none" ? (
                  <span className="dim">nothing to verify</span>
                ) : ins.descriptorCheck.state === "ok" ? (
                  <Badge tone="ok" icon="shieldCheck">bytes match the published hash</Badge>
                ) : (
                  <Badge tone="bad" icon="alert">rejected — {ins.descriptorCheck.error}</Badge>
                )}
              </dd>

              {ins.lookup?.descriptor?.storageMode === "swarm" && ins.lookup.descriptor.swarmRef && (
                <>
                  <dt>Swarm content</dt>
                  <dd><SwarmLink swarmRef={ins.lookup.descriptor.swarmRef} label={short(ins.lookup.descriptor.swarmRef, 12, 8)} /></dd>
                </>
              )}
            </dl>

            {ins.lookup && (
              <p className="t-12 dimmer" style={{ lineHeight: 1.6 }}>{ins.lookup.note}</p>
            )}
            {ins.lookupError && (
              <Callout tone="warn">The Arkiv registry mirror could not be read ({ins.lookupError}), so descriptor evidence is missing rather than assumed absent.</Callout>
            )}
            {/* Why Argos reached this conclusion, in the order it probed. Shown for everything
                except a plainly detected proxy, where the badge already says it. */}
            {ins.result.reason && (
              <Callout tone={ins.outcome.monitorable ? "info" : "warn"} icon={ins.outcome.monitorable ? "info" : "question"}>
                {ins.result.reason}
              </Callout>
            )}

            <details className="t-12">
              <summary className="dim" style={{ cursor: "pointer" }}>What Argos probed ({ins.result.probes.length} reads)</summary>
              <dl className="facts" style={{ marginTop: "var(--s-3)" }}>
                {ins.result.probes.map((p) => (
                  <Fragment key={p.name}>
                    <dt className="mono t-12">{p.name}</dt>
                    <dd className="t-12">
                      {p.result}
                      {p.decisive && <span className="dim"> — decisive</span>}
                    </dd>
                  </Fragment>
                ))}
              </dl>
            </details>

            {step === 2 && (
              <div className="row">
                {ins.outcome.monitorable ? (
                  <button className="btn primary" onClick={() => setStep(3)}>
                    Review the evidence <Icon name="arrowRight" size={14} />
                  </button>
                ) : (
                  // No identity to baseline. Offering the button would produce a baseline that
                  // can never be compared against anything, which reads as monitoring and is not.
                  <Badge tone="warn" icon="alert">Argos cannot monitor this address</Badge>
                )}
                <button className="btn" onClick={restart}>{ins.outcome.monitorable ? "Cancel" : "Try another address"}</button>
              </div>
            )}
          </div>
        </Card>
      )}

      {step === 3 && ins?.identity && ins.identityHash && (
        <Card stripe="warn">
          <CardHead title="Establish the trust baseline" sub="This is your decision, and it is the only part of Argos that depends on judgement rather than observation." icon="shield" />
          <div className="card-body stack">
            <Callout tone="warn" icon="alert">
              <b>The implementation Argos just observed is not automatically trustworthy.</b> Argos read what is deployed
              right now. It has not audited it, cannot certify it, and has no opinion on whether it is safe. Establishing a
              baseline means <i>you</i> have reviewed what is available and want future changes measured against this
              implementation.
            </Callout>

            <div className="stack-s">
              <span className="eyebrow">What you would be trusting</span>
              <dl className="facts wide">
                <dt>Contract</dt>
                <dd><AddressLink chainId={ins.chainId} address={ins.address} full /> <span className="dim t-12">on {chainName(ins.chainId)}</span></dd>
                <dt>Implementation</dt>
                <dd>
                  {/^0x0{40}$/i.test(ins.identity.implementation)
                    ? <span className="dim">—</span>
                    : <AddressLink chainId={ins.chainId} address={ins.identity.implementation} full />}
                </dd>
                <dt>Implementation codehash</dt>
                <dd className="mono" title={ins.identity.implementationCodehash}>{short(ins.identity.implementationCodehash, 18, 12)}</dd>
                <dt>Admin</dt>
                <dd>
                  {/^0x0{40}$/i.test(ins.identity.admin)
                    ? <span className="dim">not readable from the standard slot</span>
                    : <AddressLink chainId={ins.chainId} address={ins.identity.admin} full />}
                </dd>
                <dt>Observed at block</dt>
                <dd className="mono">{ins.block.toString()}</dd>
                <dt>Descriptor</dt>
                <dd>
                  {ins.lookup?.descriptor
                    ? <span className="mono t-12">{ins.lookup.descriptor.path}{ins.lookup.descriptor.attestation === "valid" ? " · attested" : ""}</span>
                    : <span className="dim">none in the registry</span>}
                </dd>
              </dl>
            </div>

            <Callout tone="info" icon="info">
              <b>What Argos cannot tell you.</b> Whether this implementation's source matches what is published, whether its
              admin is the governance path you expect, and whether an upgrade is planned. Those are the questions worth
              answering before you continue — Argos can only tell you, afterwards, that something changed.
            </Callout>

            <label className="check">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>
                I have reviewed the available contract information and want to use this implementation as my monitoring
                baseline.
              </span>
            </label>

            <div className="row">
              <button className="btn primary" onClick={() => void establish()} disabled={!confirmed}>
                <Icon name="shieldCheck" size={15} /> Establish baseline
              </button>
              <button className="btn" onClick={restart}>Cancel and investigate further</button>
            </div>
          </div>
        </Card>
      )}

      {step === 4 && ins?.identity && ins.identityHash && (
        <Card stripe={published?.state === "published" || published?.state === "already-monitored" ? "ok" : published?.state === "publishing" ? "info" : "warn"}>
          <CardHead
            title={published ? publishHeadline(published).label : "Publishing"}
            sub={
              published?.state === "published"
                ? "The baseline is on Arkiv and the server read it back. The watcher monitors this contract from its next cycle."
                : published?.state === "already-monitored"
                  ? "A baseline already existed for this contract, so nothing was written."
                  : published?.state === "publishing"
                    ? "Waiting for the Argos publisher to write the row and read it back."
                    : "Nothing is monitoring this contract. What follows is exactly why."
            }
            icon={published?.state === "published" ? "shieldCheck" : published?.state === "publishing" ? "clock" : "alert"}
          />
          <div className="card-body stack">
            <dl className="facts wide">
              <dt>Baseline implementation</dt>
              <dd>
                {/^0x0{40}$/i.test(ins.identity.implementation)
                  ? <span className="dim">—</span>
                  : <AddressLink chainId={ins.chainId} address={ins.identity.implementation} full />}
              </dd>
              <dt>Observed at block</dt>
              <dd className="mono">{ins.block.toString()}</dd>
              <dt>Code identity</dt>
              <dd className="mono" title={ins.identityHash}>{short(ins.identityHash, 18, 12)}</dd>
              <dt>Monitoring status</dt>
              <dd>
                {published ? (
                  <Badge tone={publishHeadline(published).tone} icon={published.state === "published" ? "shieldCheck" : published.state === "publishing" ? "clock" : "alert"}>
                    {publishHeadline(published).label}
                  </Badge>
                ) : (
                  <Badge tone="info" icon="clock">Publishing…</Badge>
                )}
              </dd>
              {(published?.state === "published" || published?.state === "already-monitored") && (
                <>
                  <dt>Arkiv entity</dt>
                  <dd>
                    <a className="mono t-12" href={`${ARKIV_EXPLORER}/entity/${published.entityKey}`} target="_blank" rel="noreferrer">
                      {short(published.entityKey, 14, 10)}
                    </a>
                  </dd>
                  <dt>Baseline block on Arkiv</dt>
                  <dd className="mono">{published.block}</dd>
                </>
              )}
            </dl>

            {/* Each outcome gets its own words. The old screen showed one "awaiting publication"
                badge for every case, including the ones where nothing was ever going to happen. */}
            {published?.state === "published" && (
              <Callout tone="ok" icon="shieldCheck">
                A <span className="mono">dg_baseline</span> row was published by the Argos writer and then read back from
                Arkiv to confirm it carries the code identity above. Monitoring starts on the watcher's next cycle, and the
                contract's status will read <b>Not verified</b> until the first watcher record lands — that is the absence
                of an observation, not a problem with the contract.
              </Callout>
            )}
            {published?.state === "already-monitored" && (
              <Callout tone="info" icon="info">
                Argos already had a baseline for this contract, so this request wrote nothing. Open it from{" "}
                <a href={contractHref(ins.chainId, ins.address)}>My Contracts</a> to see its current status. To move the
                trust anchor to the implementation deployed now, use the contract's own rebaseline flow — Argos never
                replaces a baseline silently.
              </Callout>
            )}
            {published?.state === "no-publisher" && (
              <Callout tone="warn" icon="lock">
                <b>This Argos build has no publisher configured, so nothing was written to Arkiv.</b> A{" "}
                <span className="mono">dg_baseline</span> row has to be signed with the Argos writer key, which lives on
                the server and never in a browser; without <span className="mono">VITE_ARGOS_API_URL</span> there is no
                server to ask. An operator can publish it with <span className="mono">npm run rebaseline -w watcher</span>.
                <br />
                <br />
                It is still checked. The baseline above is kept in this browser, and Argos compares the contract against
                it on every visit using its own reads — you will find it under{" "}
                <a href="#/contracts">My Contracts</a> with a real status. That check is weaker than the watcher&rsquo;s:
                it only runs while this page is open, so a change that is made and reverted in between would be missed.
              </Callout>
            )}
            {published?.state === "blocked" && (
              <Callout tone="warn" icon="lock">
                <b>The Argos publisher is reachable but disabled.</b> {published.message} Nothing was written, and this
                contract is not monitored. This needs an operator, not a retry.
              </Callout>
            )}
            {published?.state === "rejected" && (
              <Callout tone="bad" icon="alert">
                <b>The publisher refused this baseline.</b> {published.message} Nothing was written. Retrying the same
                request will get the same answer.
              </Callout>
            )}
            {published?.state === "unverified" && (
              <Callout tone="warn" icon="question">
                <b>The write was accepted but could not be confirmed.</b> {published.message} Argos will not call this
                contract monitored until a baseline row can be read back, so treat it as unknown rather than as either
                done or failed.
              </Callout>
            )}
            {published?.state === "failed" && (
              <Callout tone="bad" icon="alert">
                <b>The publication did not complete.</b> {published.message} Nothing here claims the contract is
                monitored. You can try again.
              </Callout>
            )}
            {published?.state === "publishing" && <Skeleton lines={2} />}

            <div className="row">
              {published?.state === "published" || published?.state === "already-monitored" ? (
                <a className="btn primary" href={contractHref(ins.chainId, ins.address)}>
                  <Icon name="contracts" size={15} /> Open this contract
                </a>
              ) : (
                <a className="btn" href="#/contracts"><Icon name="contracts" size={15} /> View in My Contracts</a>
              )}
              {(published?.state === "failed" || published?.state === "unverified") && (
                <button className="btn primary" onClick={() => void establish()}>Try publishing again</button>
              )}
              <button className="btn" onClick={restart}>Add another contract</button>
            </div>
          </div>
          <div className="card-foot">
            Argos never auto-replaces a baseline. If this implementation is upgraded, the contract is reported as changed
            and stays that way until you review the change and deliberately re-establish a baseline.
          </div>
        </Card>
      )}
    </div>
  );
}

export { navigate };
