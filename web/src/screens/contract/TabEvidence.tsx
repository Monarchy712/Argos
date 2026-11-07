/**
 * Everything the other tabs assert, with the record it came from.
 *
 * Progressive disclosure is the point: the monitoring tabs stay readable, and anyone who wants to
 * check a claim finds the Arkiv entity, the Swarm reference and the hash here — including a live
 * re-verification of the descriptor bytes against the hash published on Arkiv.
 */
import { useEffect, useState } from "react";
import { RegistryFallbackSource, SwarmFirstSource, descriptorFor, type FetchRecord, type RegistryManifest } from "../../lib/descriptors.ts";
import { lookupContract } from "../../lib/mirror.ts";
import { ARKIV_EXPLORER, CHAINS, SWARM_GATEWAY, TRUSTED_CREATORS } from "../../lib/config.ts";
import type { TabProps } from "./Workspace.tsx";
import {
  AddressLink, ArkivLink, Badge, Callout, Card, CardHead, SwarmLink, Tip, TxLink,
  ago, short,
} from "../../components/common.tsx";
import { Icon } from "../../components/icons.tsx";
import { ROUTE_LABEL } from "../../lib/chain.ts";

type Verify =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; log: FetchRecord[]; ok: boolean; route: string }
  | { state: "failed"; error: string; log: FetchRecord[]; route: string };

export function TabEvidence({ row, manifest, now }: TabProps) {
  const [verify, setVerify] = useState<Verify>({ state: "idle" });
  /**
   * Demo switch: corrupt the descriptor bytes after they are downloaded and before they are
   * hashed, which is exactly the position a compromised gateway or a network attacker occupies.
   * It exists because "we check the hash" is a claim, and a reader has no way to tell a real check
   * from a decorative one unless they can watch it fail. Nothing here touches Swarm or Arkiv —
   * only the bytes in this tab, for this one verification.
   */
  const [tamperNext, setTamperNext] = useState(false);
  /**
   * The Arkiv-backed manifest, which is the only one carrying `swarm_ref` per descriptor.
   *
   * The `manifest` prop comes from the bundled `registry-index.json` that ships with the app — a
   * last-resort copy for when Arkiv is unreachable, and it has no `swarm` map at all. Using it
   * here meant this tab silently verified against the pinned GitHub commit and never touched
   * Swarm, while the page claimed Swarm was the source. `lookupContract` reuses the session's
   * bulk mirror read, so this costs no extra Arkiv query.
   */
  const [mirror, setMirror] = useState<RegistryManifest | null>(null);
  useEffect(() => {
    let alive = true;
    void lookupContract(row.chainId, row.address).then(
      (l) => alive && setMirror(l.manifest),
      () => alive && setMirror(null),
    );
    return () => { alive = false; };
  }, [row.chainId, row.address]);

  // Prefer Arkiv; fall back to the bundled index only when Arkiv could not be read.
  const index = mirror ?? manifest;
  const desc = index ? descriptorFor(index, row.chainId, row.address) : null;
  const swarmEntry = desc && index?.swarm?.[desc.path];
  const explorer = CHAINS[row.chainId]?.explorer;

  async function verifyDescriptor() {
    if (!index || !desc) return;
    const route = ROUTE_LABEL;
    setVerify({ state: "running" });
    const opts = { tamperPath: tamperNext ? desc.path : null };
    const source =
      index.swarm && Object.keys(index.swarm).length > 0
        ? new SwarmFirstSource(index, opts)
        : new RegistryFallbackSource(index, opts);
    try {
      await source.fetchDescriptor(desc.path);
      setVerify({ state: "done", log: [...source.log], ok: source.log.every((f) => f.ok || f.fellBack), route });
    } catch (err) {
      setVerify({
        state: "failed",
        error: (err instanceof Error ? err.message : String(err)).split("\n")[0]!,
        log: [...source.log],
        route,
      });
    }
  }

  return (
    <>
      <Callout tone="info" icon="database">
        Every status Argos shows rests on a record someone else can read. Arkiv entities carry a{" "}
        <span className="mono">$creator</span>, so you can confirm a row came from the Argos writer or watcher and not from
        anyone else. Swarm content is addressed by hash, so the bytes cannot change without the reference changing.
      </Callout>

      <Card>
        <CardHead title="Ethereum" sub="On-chain references for this contract." icon="chain" />
        <div className="evidence">
          <Row k="Network">
            <span className="t-13">{CHAINS[row.chainId]?.name ?? `chain ${row.chainId}`} <span className="mono dimmer">({row.chainId})</span></span>
          </Row>
          <Row k="Proxy address" v={row.address}>
            <AddressLink chainId={row.chainId} address={row.address} />
          </Row>
          <Row k="Baseline implementation" v={row.baseline.implementation}>
            <AddressLink chainId={row.chainId} address={row.baseline.implementation} />
          </Row>
          {row.current && (
            <Row k="Observed implementation" v={row.current.implementation}>
              <AddressLink chainId={row.chainId} address={row.current.implementation} tone={row.current.matchesBaseline ? undefined : "bad"} />
            </Row>
          )}
          <Row k="Baseline block" v={row.baseline.block.toString()}>
            {explorer && <a className="addr" href={`${explorer}/block/${row.baseline.block}`} target="_blank" rel="noreferrer"><span className="val">View block</span><Icon name="external" size={11} /></a>}
          </Row>
          <Row k="Last checked block" v={row.current ? row.current.checkedBlock.toString() : "no watcher record"}>
            {row.current && explorer && <a className="addr" href={`${explorer}/block/${row.current.checkedBlock}`} target="_blank" rel="noreferrer"><span className="val">View block</span><Icon name="external" size={11} /></a>}
          </Row>
          {row.change && (
            <Row k="Upgrade transaction" v={row.change.txHash || "found by slot read"}>
              {row.change.txHash && <TxLink chainId={row.chainId} tx={row.change.txHash} />}
            </Row>
          )}
          <Row k="Proxy architecture" v={`${row.proxyKind} · detection ${row.detection}`} />
        </div>
      </Card>

      <Card>
        <CardHead title="Arkiv records" sub="The monitoring state and history, published as queryable entities." icon="database" />
        <div className="evidence">
          <Row k="Baseline" v={row.baseline.key}>
            <ArkivLink entityKey={row.baseline.key} label="dg_baseline" />
          </Row>
          <Row k="Current state" v={row.current?.key ?? "never written, or expired"}>
            {row.current ? <ArkivLink entityKey={row.current.key} label="dg_current_state" /> : <Badge tone="warn" icon="question">Not verified</Badge>}
          </Row>
          <Row k="Latest change" v={row.change?.key ?? "no change recorded since baseline"}>
            {row.change ? <ArkivLink entityKey={row.change.key} label="dg_latest_change" /> : <Badge tone="ok" icon="check">None</Badge>}
          </Row>
          <Row k="Change note" v={row.changeNote?.key ?? "no explanation generated"}>
            {row.changeNote ? <ArkivLink entityKey={row.changeNote.key} label="dg_change_note" /> : <span className="dimmer t-12">—</span>}
          </Row>
          <Row k="Baseline writer" v={TRUSTED_CREATORS.writer}>
            <a className="addr" href={`${ARKIV_EXPLORER}/address/${TRUSTED_CREATORS.writer}`} target="_blank" rel="noreferrer"><span className="val">{short(TRUSTED_CREATORS.writer, 8, 6)}</span><Icon name="external" size={11} /></a>
          </Row>
          <Row k="Observation writer" v={TRUSTED_CREATORS.watcher}>
            <a className="addr" href={`${ARKIV_EXPLORER}/address/${TRUSTED_CREATORS.watcher}`} target="_blank" rel="noreferrer"><span className="val">{short(TRUSTED_CREATORS.watcher, 8, 6)}</span><Icon name="external" size={11} /></a>
          </Row>
        </div>
        <div className="card-foot">
          Rows created by any other address are ignored by this app. <span className="mono">dg_current_state</span> rows carry
          the time they were written and are kept for months, while a contract turns to Not verified as soon as its newest
          reading is over five minutes old — so a stopped watcher cannot leave a stale green, and the trail of when it
          stopped survives to be read.
        </div>
      </Card>

      <Card>
        <CardHead
          title="Descriptor & hash verification"
          sub="What a wallet would render for this address, and whether the bytes still hash to what Arkiv publishes."
          icon="file"
          actions={
            desc ? (
              <button className="btn sm" onClick={() => void verifyDescriptor()} disabled={verify.state === "running"}>
                <Icon name="shieldCheck" size={13} /> {verify.state === "running" ? "Verifying…" : "Verify now"}
              </button>
            ) : undefined
          }
        />
        {!desc ? (
          <div className="card-body">
            <p className="prose">
              The ERC-7730 registry mirror has no calldata descriptor bound to this address, so there is nothing for a wallet
              to render a readable intent from — and nothing for Argos to hash-check. The code behind the address is still
              monitored.
            </p>
          </div>
        ) : (
          <>
            <div className="evidence">
              <Row k="Registry file" v={desc.path} />
              <Row k="Registry commit" v={index?.commit ?? "—"} />
              <Row k="ERC-8176 hash" v={desc.descriptorHash ?? "—"}>
                <Tip text="A hash over the resolved descriptor bytes. Argos recomputes it from whatever it downloads and refuses to render a descriptor that does not match." />
              </Row>
              <Row k="Hash recorded at baseline" v={row.baseline.descriptorHash || "baseline records no descriptor hash"}>
                {row.baseline.descriptorHash && desc.descriptorHash && (
                  <Badge tone={row.baseline.descriptorHash === desc.descriptorHash ? "ok" : "warn"} icon={row.baseline.descriptorHash === desc.descriptorHash ? "check" : "alert"}>
                    {row.baseline.descriptorHash === desc.descriptorHash ? "Unchanged since baseline" : "Descriptor changed"}
                  </Badge>
                )}
              </Row>
              <Row k="Attestation" v={desc.attested ? "an auditor attestation signs this exact descriptor" : "none in the registry"} />
              {swarmEntry && (
                <Row k="Swarm content" v={swarmEntry.ref}>
                  <SwarmLink swarmRef={swarmEntry.ref} />
                </Row>
              )}
              {row.baseline.swarmRef && !swarmEntry && (
                <Row k="Swarm content (baseline)" v={row.baseline.swarmRef}>
                  <SwarmLink swarmRef={row.baseline.swarmRef} />
                </Row>
              )}
            </div>

            <div className="card-body" style={{ borderTop: "1px solid var(--divider)" }}>
              <label className="check">
                <input type="checkbox" checked={tamperNext} onChange={(e) => setTamperNext(e.target.checked)} />
                <span>
                  <b>Demo: corrupt the bytes after download.</b> Changes one word in the descriptor between the gateway
                  serving it and Argos hashing it — what a compromised gateway or a network attacker could do. Then press
                  Verify now: the hash stops matching what Arkiv publishes, and Argos renders nothing from it rather than
                  falling back to another copy.
                </span>
              </label>
            </div>

            {verify.state !== "idle" && (
              <div className="card-body" style={{ borderTop: "1px solid var(--divider)" }}>
                {verify.state === "running" && <p className="t-13 dim">Fetching the descriptor bytes and recomputing their hash…</p>}
                {verify.state === "failed" && (
                  <Callout tone="bad">
                    <b>Descriptor rejected: {tamperNext ? "the corrupted bytes do not match the published hash" : "verification failed"}.</b>{" "}
                    {verify.error}
                    {tamperNext && (
                      <>
                        {" "}Nothing was rendered from these bytes. A mismatch is never a reason to try another source —
                        that would let whoever broke the first copy choose the second.
                      </>
                    )}
                  </Callout>
                )}
                {verify.state === "done" && verify.ok && (
                  <Callout tone="ok"><b>Verified.</b> Every file fetched hashes to the value published on Arkiv.</Callout>
                )}
                {(verify.state === "done" || verify.state === "failed") && verify.log.length > 0 && (
                  <ul className="vlog" style={{ marginTop: "var(--s-3)" }}>
                    {verify.log.map((f, i) => (
                      <li key={`${f.path}-${i}`} className={f.ok ? "ok" : f.fellBack ? "warn" : "bad"}>
                        <Icon name={f.ok ? "check" : f.fellBack ? "question" : "close"} size={12} />
                        <span>
                          <span className={`src src-${f.via}`}>{f.via === "swarm" ? "SWARM" : "REGISTRY"}</span>{" "}
                          <a href={f.url} target="_blank" rel="noreferrer">{f.path}</a>
                          {f.ok && f.via === "swarm" ? " — resolved bytes match the ERC-8176 hash on Arkiv" : ""}
                          {f.error ? ` — ${f.error}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
        <div className="card-foot">
          Descriptor bytes are fetched from Swarm first ({SWARM_GATEWAY.replace(/^https?:\/\//, "")}), falling back to the
          pinned registry commit if the gateway is unreachable. A hash mismatch is never a fallback: tampered bytes are
          rejected and nothing is rendered from them.
        </div>
      </Card>

      <Card>
        <CardHead title="Record freshness" sub="Why this contract shows the status it does, right now." icon="clock" />
        <div className="card-body">
          <dl className="facts wide">
            <dt>Baseline established</dt>
            <dd className="mono">{new Date(row.baseline.baselinedAt * 1000).toISOString().replace("T", " ").slice(0, 19)}Z · {ago(row.baseline.baselinedAt, now)}</dd>
            <dt>Last observation</dt>
            <dd className="mono">{row.current ? `${new Date(row.current.checkedAt * 1000).toISOString().replace("T", " ").slice(0, 19)}Z · ${ago(row.current.checkedAt, now)}` : "no record"}</dd>
            <dt>Record kept until</dt>
            <dd className="mono">
              {row.current
                ? row.current.expiresAt > now
                  ? `${Math.round((row.current.expiresAt - now) / 86400)} days from now`
                  : "expired"
                : "—"}
            </dd>
            <dt>Ever changed since baseline</dt>
            <dd>{row.current ? (row.current.everChanged ? <Badge tone="warn" icon="alert">Yes</Badge> : <Badge tone="ok" icon="check">No</Badge>) : <span className="dimmer">unknown</span>}</dd>
          </dl>
        </div>
      </Card>
    </>
  );
}

function Row({ k, v, children }: { k: string; v?: string; children?: React.ReactNode }) {
  return (
    <div className="ev-row">
      <span className="ev-k">{k}</span>
      <span className="ev-v">{v ?? ""}</span>
      <span>{children}</span>
    </div>
  );
}
