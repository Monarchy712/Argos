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
import { useState } from "react";
import { classifyContract, codeIdentityHash, readIdentity, PROXY_KINDS, type Classification, type CodeIdentity, type ProxyKind } from "@driftguard/core";
import { getAddress, isAddress, type Address } from "viem";
import { clientFor } from "../lib/chain.ts";
import { CHAINS } from "../lib/config.ts";
import { lookupContract, type ContractLookup } from "../lib/mirror.ts";
import { RegistryFallbackSource, SwarmFirstSource, type FetchRecord, type RegistryManifest } from "../lib/descriptors.ts";
import { pendingStore } from "../lib/pending.ts";
import { contractHref, navigate } from "../lib/router.ts";
import { routeLabel } from "../lib/transport.ts";
import type { MonitoredRow } from "../lib/rows.ts";
import { PageHead } from "../components/Shell.tsx";
import {
  AddressLink, Badge, Callout, Card, CardHead, Skeleton, SwarmLink, Tip,
  chainName, short, toast, useTransport,
} from "../components/common.tsx";
import { Icon } from "../components/icons.tsx";

type Step = 1 | 2 | 3 | 4;

interface Inspection {
  chainId: number;
  address: Address;
  block: bigint;
  kind: Classification;
  identity: CodeIdentity;
  identityHash: `0x${string}`;
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

export function AddContractScreen({ rows, manifest }: { rows: MonitoredRow[]; manifest: RegistryManifest | null }) {
  const transport = useTransport();
  const [step, setStep] = useState<Step>(1);
  const [chainId, setChainId] = useState<number>(1);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ins, setIns] = useState<Inspection | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const trimmed = address.trim();
  const validAddress = isAddress(trimmed);
  const already = validAddress ? rows.find((r) => r.chainId === chainId && r.address.toLowerCase() === trimmed.toLowerCase()) ?? null : null;

  async function inspect() {
    if (!validAddress) return;
    setError(null);
    setBusy(true);
    const t0 = performance.now();
    const route = routeLabel(transport.mode);
    const addr = getAddress(trimmed);
    try {
      const client = clientFor(chainId);
      const block = (await client.getBlockNumber()) - 2n;
      const { kind } = await classifyContract(client, addr, block);

      if (kind === "no-code") throw new Error("There is no contract code at this address on the selected network.");

      const proxyKind = ((PROXY_KINDS as readonly string[]).includes(kind) ? kind : "none") as ProxyKind;
      const identity = await readIdentity(client, addr, proxyKind, block);

      // Registry evidence (bulk mirror read, contract-independent where the budget allows it).
      let lookup: ContractLookup | null = null;
      let lookupError: string | null = null;
      try {
        lookup = await lookupContract(chainId, addr);
      } catch (err) {
        lookupError = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      }

      // If a descriptor exists, actually fetch and hash-check it rather than claiming it is fine.
      let descriptorCheck: Inspection["descriptorCheck"] = { state: "none" };
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
        chainId, address: addr, block, kind, identity,
        identityHash: codeIdentityHash(identity),
        lookup, lookupError, descriptorCheck, route,
        ms: Math.round(performance.now() - t0),
      });
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message.split("\n")[0]! : String(err));
    } finally {
      setBusy(false);
    }
  }

  function establish() {
    if (!ins || !confirmed) return;
    pendingStore.add({
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
    });
    toast("Baseline request recorded");
    setStep(4);
  }

  function restart() {
    setStep(1); setIns(null); setConfirmed(false); setError(null); setAddress("");
  }

  return (
    <div className="page">
      <PageHead
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
            {error && <Callout tone="bad">{error}</Callout>}

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
        <Card stripe={ins.kind === "none" ? "warn" : "info"}>
          <CardHead
            title="Contract inspection"
            sub={`Read at block ${ins.block} in ${ins.ms} ms, ${ins.route}.`}
            icon="search"
            actions={step === 2 ? <button className="btn sm ghost" onClick={restart}>Start over</button> : undefined}
          />
          <div className="card-body stack">
            <dl className="facts wide">
              <dt>
                Detected proxy type
                <Tip text="Argos reads the EIP-1967 implementation and beacon slots, the diamond loupe, and the Safe singleton slot. Anything else is reported as unsupported rather than guessed at." />
              </dt>
              <dd>
                {(PROXY_KINDS as readonly string[]).includes(ins.kind) && ins.kind !== "none" ? (
                  <Badge tone="info" icon="layers">{ins.kind}</Badge>
                ) : (
                  <Badge tone="warn" icon="question">not an upgradeable pattern Argos can read</Badge>
                )}
              </dd>

              <dt>Current implementation</dt>
              <dd>
                {/^0x0{40}$/i.test(ins.identity.implementation)
                  ? <span className="dim">{ins.kind === "diamond" ? "diamond — identity is a hash over facets" : "none readable"}</span>
                  : <AddressLink chainId={ins.chainId} address={ins.identity.implementation} full />}
              </dd>

              <dt>Code identity</dt>
              <dd className="mono" title={ins.identityHash}>{short(ins.identityHash, 18, 12)}</dd>

              <dt>Latest observed block</dt>
              <dd className="mono">{ins.block.toString()}</dd>

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
            {!(PROXY_KINDS as readonly string[]).includes(ins.kind) && (
              <Callout tone="warn">
                Argos could not identify an upgrade mechanism it knows how to read at this address. If you establish a
                baseline anyway, monitoring will report <b>Not verified</b> rather than claiming the code is unchanged.
              </Callout>
            )}

            {step === 2 && (
              <div className="row">
                <button className="btn primary" onClick={() => setStep(3)}>
                  Review the evidence <Icon name="arrowRight" size={14} />
                </button>
                <button className="btn" onClick={restart}>Cancel</button>
              </div>
            )}
          </div>
        </Card>
      )}

      {step === 3 && ins && (
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
              <button className="btn primary" onClick={establish} disabled={!confirmed}>
                <Icon name="shieldCheck" size={15} /> Establish baseline
              </button>
              <button className="btn" onClick={restart}>Cancel and investigate further</button>
            </div>
          </div>
        </Card>
      )}

      {step === 4 && ins && (
        <Card stripe="ok">
          <CardHead title="Baseline recorded" sub="Your decision is saved. Monitoring begins when the record is published." icon="shieldCheck" />
          <div className="card-body stack">
            <dl className="facts wide">
              <dt>Baseline implementation</dt>
              <dd>
                {/^0x0{40}$/i.test(ins.identity.implementation)
                  ? <span className="dim">—</span>
                  : <AddressLink chainId={ins.chainId} address={ins.identity.implementation} full />}
              </dd>
              <dt>Baseline block</dt>
              <dd className="mono">{ins.block.toString()}</dd>
              <dt>Baseline timestamp</dt>
              <dd className="mono">{new Date().toISOString().replace("T", " ").slice(0, 19)}Z</dd>
              <dt>Code identity</dt>
              <dd className="mono" title={ins.identityHash}>{short(ins.identityHash, 18, 12)}</dd>
              <dt>Monitoring status</dt>
              <dd><Badge tone="warn" icon="clock">Awaiting baseline publication</Badge></dd>
            </dl>

            <Callout tone="info" icon="lock">
              <b>Your browser holds no key, so it cannot publish this record.</b> A{" "}
              <span className="mono">dg_baseline</span> row is written on Arkiv by the Argos writer. Until it is published,
              this contract has no status — and Argos deliberately shows it as awaiting publication rather than as verified.
              You will find it under <a href="#/contracts">My Contracts</a>.
            </Callout>

            <div className="row">
              <a className="btn primary" href="#/contracts">
                <Icon name="contracts" size={15} /> View in My Contracts
              </a>
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
