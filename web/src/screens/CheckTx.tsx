import { useEffect, useMemo, useState } from "react";
import { computeStatus, riskyCalldataFlags, PROXY_KINDS, type ProxyKind, type LiveEvidence, type RiskFlag, type StatusResult } from "@driftguard/core";
import { format, type DisplayModel } from "@ethereum-sourcify/clear-signing";
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, getAddress, isAddress, isHex, parseAbi, parseTransaction, serializeTransaction, type Address, type Hex } from "viem";
import { idOf, readArkiv, type ArkivSnapshot } from "../lib/arkiv.ts";
import { clientFor, liveIdentity } from "../lib/chain.ts";
import { CHAINS, DEMO_PROXY, GUARD_DEMO } from "../lib/config.ts";
import { RegistryFallbackSource, SwarmFirstSource, descriptorFor, makeResolver, type FetchRecord, type RegistryManifest } from "../lib/descriptors.ts";
import { loadMirror, lookupContract, type Mirror } from "../lib/mirror.ts";
import { routeLabel } from "../lib/transport.ts";
import { AddressLink, ArkivLink, StatusBadge, SwarmLink, chainName, short, useTransport } from "../components/common.tsx";

interface Tx {
  chainId: number;
  to: string;
  data: Hex;
  value: bigint;
  source: "json" | "raw";
}

// ---- examples ------------------------------------------------------------------------------
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ME = "0x000000000000000000000000000000000000dEaD";
const aaveSupply = encodeFunctionData({
  abi: parseAbi(["function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)"]),
  args: [USDC, 100_000_000n, ME, 0],
});
const demoIncrement = encodeFunctionData({ abi: parseAbi(["function increment()"]), args: [] });
const demoUpgrade = encodeFunctionData({
  abi: parseAbi(["function upgradeAndCall(address proxy, address implementation, bytes data)"]),
  args: [DEMO_PROXY.address, "0x1F31ab6fE4C931Ab7413523f75D490E1e0b63B4B", "0x"],
});
const EXAMPLES: { label: string; value: string }[] = [
  { label: "Aave v3: supply 100 USDC (mainnet, monitored)", value: JSON.stringify({ chainId: 1, to: AAVE_POOL, data: aaveSupply }, null, 2) },
  { label: "Demo proxy: increment() (Sepolia, monitored)", value: JSON.stringify({ chainId: DEMO_PROXY.chainId, to: DEMO_PROXY.address, data: demoIncrement }, null, 2) },
  { label: "Guard demo proxy: increment() (Sepolia, check-and-call guard)", value: JSON.stringify({ chainId: GUARD_DEMO.chainId, to: GUARD_DEMO.proxy, data: demoIncrement }, null, 2) },
  { label: "ProxyAdmin: upgrade the demo proxy (risky calldata)", value: JSON.stringify({ chainId: DEMO_PROXY.chainId, to: "0x26c64D91f0d2e8AE6449Adf774f5Abe610e80d13", data: demoUpgrade }, null, 2) },
  {
    label: "Raw transaction hex (Aave supply, EIP-1559)",
    value: serializeTransaction({ chainId: 1, type: "eip1559", to: AAVE_POOL, data: aaveSupply, nonce: 7, gas: 300_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
  },
];

function parseInput(text: string): Tx {
  const t = text.trim();
  if (t.startsWith("{")) {
    const j = JSON.parse(t);
    const chainId = Number(j.chainId);
    if (!CHAINS[chainId]) throw new Error(`chainId ${j.chainId} is not supported (Ethereum 1, Sepolia 11155111)`);
    if (!isAddress(j.to)) throw new Error("`to` must be an address");
    if (!isHex(j.data)) throw new Error("`data` must be 0x-hex calldata");
    return { chainId, to: getAddress(j.to), data: j.data, value: BigInt(j.value ?? 0), source: "json" };
  }
  if (isHex(t)) {
    const p = parseTransaction(t as Hex);
    if (!p.to) throw new Error("contract creation: nothing to check");
    if (!p.chainId) throw new Error("legacy transaction without chainId: paste {chainId, to, data} instead");
    if (!CHAINS[p.chainId]) throw new Error(`chainId ${p.chainId} is not supported`);
    return { chainId: p.chainId, to: getAddress(p.to), data: (p.data ?? "0x") as Hex, value: p.value ?? 0n, source: "raw" };
  }
  throw new Error("Paste {\"chainId\", \"to\", \"data\"} JSON or a raw transaction (0x…).");
}

const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function name() view returns (string)"]);

const guardAbi = parseAbi([
  "function checkAndCall(address proxy, address expectedImplementation, bytes data) payable returns (bytes)",
  "error ImplementationChanged(address proxy, address expected, address actual)",
]);

/** Controlled demo: what ArgosGuard.checkAndCall would do right now, by eth_call (nothing is sent). */
type GuardSim =
  | { state: "ok"; expected: Address; guardedData: Hex; block: bigint }
  | { state: "reverted"; expected: Address; actual: Address; guardedData: Hex; block: bigint }
  | { state: "error"; expected: Address; guardedData: Hex; error: string };

async function simulateGuard(tx: Tx, expected: Address): Promise<GuardSim> {
  const guardedData = encodeFunctionData({ abi: guardAbi, functionName: "checkAndCall", args: [getAddress(tx.to), expected, tx.data] });
  const client = clientFor(tx.chainId);
  const block = await client.getBlockNumber().catch(() => 0n);
  try {
    await client.call({ to: GUARD_DEMO.guard, data: guardedData, value: tx.value });
    return { state: "ok", expected, guardedData, block };
  } catch (err) {
    try {
      await client.simulateContract({ address: GUARD_DEMO.guard, abi: guardAbi, functionName: "checkAndCall", args: [getAddress(tx.to), expected, tx.data], value: tx.value });
    } catch (e2) {
      const rev = e2 instanceof BaseError ? e2.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      if (rev instanceof ContractFunctionRevertedError && rev.data?.errorName === "ImplementationChanged") {
        return { state: "reverted", expected, actual: (rev.data.args as Address[])[2]!, guardedData, block };
      }
    }
    return { state: "error", expected, guardedData, error: (err instanceof Error ? err.message : String(err)).split("\n")[0]! };
  }
}

interface Result {
  tx: Tx;
  flags: RiskFlag[];
  status: StatusResult;
  live: LiveEvidence & { ms?: number; route?: string };
  display: DisplayModel | null;
  displayError: string | null;
  fetches: FetchRecord[];
  descriptor: { path: string; descriptorHash: string | null; attestation: "valid" | "stale" | "none"; commit: string; owner: string; arkivKey?: string; swarmRef?: string } | null;
  baselineDescriptorHash: string | null;
  /** controlled demo only: set when the target is the guard demo proxy */
  guard?: GuardSim | null;
  /** where the descriptor metadata (path, commit, hashes) came from */
  provenance: { source: "arkiv-bulk" | "arkiv-targeted" | "bundled"; note: string };
}

export function CheckTxScreen({ snap: snapshot, manifest }: { snap: ArkivSnapshot | null; manifest: RegistryManifest | null }) {
  const transport = useTransport();
  const [input, setInput] = useState(EXAMPLES[0]!.value);
  const [tamperDemo, setTamperDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  // Warm the Arkiv registry mirror as soon as this screen opens (bulk, contract-independent,
  // ~35 paged keyless queries, ~11 s), so the first check doesn't wait for it.
  const [mirror, setMirror] = useState<{ state: "loading" | "ready" | "failed"; m?: Mirror; error?: string }>({ state: "loading" });
  useEffect(() => {
    let live = true;
    loadMirror().then(
      (m) => live && setMirror({ state: "ready", m }),
      (e) => live && setMirror({ state: "failed", error: e instanceof Error ? e.message.split(/\r?\n/)[0] : String(e) }),
    );
    return () => {
      live = false;
    };
  }, []);
  const preview = useMemo(() => {
    try {
      return parseInput(input);
    } catch {
      return null;
    }
  }, [input]);

  async function run() {
    setError(null);
    setResult(null);
    let tx: Tx;
    try {
      tx = parseInput(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    // Read Arkiv fresh for the check (one bulk read, same as the table), so the verdict uses the
    // newest watcher record; fall back to the page's snapshot if Arkiv is unreachable.
    const snap = await readArkiv().catch(() => snapshot);
    const flags = riskyCalldataFlags(tx.data);
    const id = idOf(tx.chainId, tx.to);
    const baseline = snap?.baselines.find((b) => idOf(b.chainId, b.address) === id) ?? null;
    const current = snap?.current.find((c) => idOf(c.chainId, c.address) === id) ?? null;
    const change = snap?.changes.find((c) => idOf(c.chainId, c.address) === id) ?? null;
    // Descriptor metadata from the Arkiv mirror (bulk read; targeted fallback says so). The index
    // bundled with the app is used only if Arkiv can't be reached at all, and that is shown too.
    const lookup = await lookupContract(tx.chainId, tx.to).catch(() => null);
    const index: RegistryManifest | null = lookup?.manifest ?? manifest;
    const provenance: Result["provenance"] = lookup
      ? { source: lookup.mode === "bulk" ? "arkiv-bulk" : "arkiv-targeted", note: lookup.note }
      : { source: "bundled", note: "Arkiv mirror unreachable: using the descriptor index bundled with this app (same pinned registry commit, same hash checks)." };
    const descriptor: Result["descriptor"] = lookup?.descriptor
      ? {
          path: lookup.descriptor.path,
          descriptorHash: lookup.descriptor.descriptorHash || null,
          attestation: lookup.descriptor.attestation as "valid" | "stale" | "none",
          commit: lookup.descriptor.commit,
          owner: lookup.descriptor.owner,
          arkivKey: lookup.descriptor.key,
          swarmRef: lookup.descriptor.storageMode === "swarm" ? lookup.descriptor.swarmRef : undefined,
        }
      : !lookup && manifest
        ? (() => {
            const d = descriptorFor(manifest, tx.chainId, tx.to);
            return d ? { path: d.path, descriptorHash: d.descriptorHash, attestation: d.attested ? "valid" : "none", commit: manifest.commit, owner: d.owner } : null;
          })()
        : null;
    const now = Math.floor(Date.now() / 1000);
    const evaluate = (live: LiveEvidence) =>
      computeStatus({
        now,
        monitored: !!baseline,
        supported: !!baseline && (PROXY_KINDS as readonly string[]).includes(baseline.proxyKind),
        baseline: baseline && { codeIdentity: baseline.codeIdentity, block: baseline.block },
        current: current && {
          codeIdentity: current.codeIdentity,
          matchesBaseline: current.matchesBaseline,
          everChangedSinceBaseline: current.everChanged,
          checkedBlock: current.checkedBlock,
          checkedAt: current.checkedAt,
          expiresAt: current.expiresAt,
        },
        latestChange: change && { field: change.field, changeBlock: change.changeBlock, txHash: change.txHash },
        live,
      });
    const route = routeLabel(transport.mode);
    const base: Result = {
      tx,
      flags,
      status: evaluate(baseline ? { state: "pending" } : { state: "not-run" }),
      live: baseline ? { state: "pending", route } : { state: "not-run" },
      display: null,
      displayError: null,
      fetches: [],
      descriptor,
      baselineDescriptorHash: baseline?.descriptorHash || null,
      provenance,
    };
    setResult(base);

    // Live check (only for monitored contracts: it compares against their baseline).
    const livePromise: Promise<Result["live"]> = baseline
      ? liveIdentity(tx.chainId, tx.to as `0x${string}`, baseline.proxyKind as ProxyKind).then(
          (r) => ({ state: "ok" as const, codeIdentity: r.identityHash, block: r.block, ms: r.ms, route }),
          (err) => ({ state: "failed" as const, error: (err instanceof Error ? err.message : String(err)).split("\n")[0]!, route }),
        )
      : Promise.resolve({ state: "not-run" as const });

    // Readable intent through the hash-checked descriptor source (same transport).
    // Swarm first when the writer recorded swarm refs on Arkiv; otherwise the registry. Both check hashes.
    const tamperPath = tamperDemo ? descriptor?.path ?? null : null;
    const source = !index ? null : index.swarm && Object.keys(index.swarm).length > 0 ? new SwarmFirstSource(index, { tamperPath }) : new RegistryFallbackSource(index, { tamperPath });
    const displayPromise = source
      ? format(
          { chainId: tx.chainId, to: tx.to, data: tx.data, value: tx.value },
          {
            descriptorResolverOptions: { type: "custom", resolver: makeResolver(index!, source) },
            externalDataProvider: {
              resolveToken: async (chainId, token) => {
                try {
                  const c = clientFor(chainId);
                  const a = getAddress(token);
                  const [decimals, symbol, name] = await Promise.all([
                    c.readContract({ address: a, abi: erc20, functionName: "decimals" }),
                    c.readContract({ address: a, abi: erc20, functionName: "symbol" }),
                    c.readContract({ address: a, abi: erc20, functionName: "name" }),
                  ]);
                  return { decimals, symbol, name };
                } catch {
                  return null; // library falls back to raw amounts
                }
              },
            },
          },
        ).then(
          (d) => ({ display: d, displayError: null }),
          (err) => ({ display: null, displayError: err instanceof Error ? err.message : String(err) }),
        )
      : Promise.resolve({ display: null, displayError: "no descriptor index available (Arkiv mirror and bundled index both unavailable)" });

    const isGuardDemo = tx.chainId === GUARD_DEMO.chainId && tx.to.toLowerCase() === GUARD_DEMO.proxy.toLowerCase();
    const guardPromise: Promise<GuardSim | null> = isGuardDemo && baseline ? simulateGuard(tx, getAddress(baseline.implementation)) : Promise.resolve(null);
    const [live, shown, guard] = await Promise.all([livePromise, displayPromise, guardPromise]);
    setResult({ ...base, live, status: evaluate(live), ...shown, fetches: source?.log ?? [], guard });
    setBusy(false);
  }

  return (
    <section>
      <h1 className="section-title">Check a transaction</h1>
      <p className="section-sub">
        Paste a transaction. Argos shows the raw calldata, renders the readable ERC-7730 intent from a hash-checked
        descriptor, flags calls that change contract code, and checks whether the code behind <code>to</code> still matches
        its baseline. Live reads go {routeLabel(transport.mode)}.
      </p>

      <div className="grid-2">
        <div className="card card-pad stack">
          <div>
            <label htmlFor="tx-input">Transaction: {"{"}chainId, to, data{"}"} JSON or raw hex</label>
            <textarea id="tx-input" rows={9} value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} />
          </div>
          <div className="row">
            <label className="check" style={{ margin: 0 }} title="Modifies the downloaded descriptor in this browser before the hash check, to show it gets rejected">
              <input type="checkbox" checked={tamperDemo} onChange={(e) => setTamperDemo(e.target.checked)} /> Demo: tamper with the downloaded descriptor
            </label>
            <button className="btn btn-primary" onClick={() => void run()} disabled={busy}>
              {busy ? "Checking…" : "Check transaction"}
            </button>
            <select aria-label="Load an example" value="" onChange={(e) => e.target.value && setInput(e.target.value)} style={{ width: "auto", fontFamily: "var(--sans)" }}>
              <option value="">Load an example…</option>
              {EXAMPLES.map((x) => (
                <option key={x.label} value={x.value}>{x.label}</option>
              ))}
            </select>
          </div>
          {error && <div className="callout callout-red">{error}</div>}
          <div className="small muted">
            {mirror.state === "loading" && "Loading the ERC-7730 registry mirror from Arkiv (bulk read, the same for every visitor)…"}
            {mirror.state === "ready" && mirror.m && `Registry mirror loaded from Arkiv: ${mirror.m.descriptors.length} descriptors, ${mirror.m.deployments.length} deployments @ ${mirror.m.commit.slice(0, 7)} (${mirror.m.queries} queries, ${(mirror.m.ms / 1000).toFixed(1)} s).`}
            {mirror.state === "failed" && `Registry mirror bulk read failed (${mirror.error}); checks will look up the one contract instead and say so.`}
          </div>
          {!snapshot && <div className="callout">Arkiv data is still loading; monitored status will show as Not verified until it arrives.</div>}
        </div>

        <div className="card card-pad stack">
          <div className="tile-label">Raw transaction</div>
          {preview ? (
            <>
              <dl className="kv">
                <dt>parsed from</dt><dd>{preview.source === "raw" ? "raw transaction hex" : "JSON"}</dd>
                <dt>chain</dt><dd>{chainName(preview.chainId)} ({preview.chainId})</dd>
                <dt>to</dt><dd><AddressLink chainId={preview.chainId} address={preview.to} full /></dd>
                <dt>value</dt><dd className="mono">{preview.value.toString()} wei</dd>
                <dt>selector</dt><dd className="mono">{preview.data.slice(0, 10)}</dd>
              </dl>
              <div className="hex">{preview.data}</div>
            </>
          ) : (
            <p className="muted small">Paste a transaction to see its fields.</p>
          )}
        </div>
      </div>

      {result && <ResultView r={result} />}
    </section>
  );
}

function ResultView({ r }: { r: Result }) {
  const transport = useTransport();
  const d = r.display;
  const intent = d?.interpolatedIntent ?? (typeof d?.intent === "string" ? d.intent : d?.intent ? Object.values(d.intent)[0] : undefined);
  const hashMatches = r.baselineDescriptorHash && r.descriptor?.descriptorHash ? r.baselineDescriptorHash === r.descriptor.descriptorHash : null;
  const rejected = r.fetches.find((f) => !f.ok && /hash mismatch/.test(f.error ?? ""));
  return (
    <div className="stack" style={{ marginTop: 16 }}>
      <div className={`card card-pad ${r.status.status === "RED" ? "callout-red" : ""}`} style={{ borderWidth: r.status.status === "RED" ? 2 : 1 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            <StatusBadge status={r.status.status} large />
            <div>
              <div style={{ fontWeight: 700, fontSize: 17 }}>{r.status.headline}</div>
              <div className="small muted">
                Contract {short(r.tx.to, 8, 6)} on {chainName(r.tx.chainId)}
              </div>
            </div>
          </div>
          <LiveLine live={r.live} />
        </div>
        {r.status.note && <div className="note note-warn" style={{ marginTop: 10 }}>{r.status.note}</div>}
        <ul className="reason-list">
          {r.status.reasons.map((x) => <li key={x}>{x}</li>)}
        </ul>
      </div>

      {r.guard && <GuardPanel g={r.guard} />}

      {r.flags.length > 0 && (
        <div className="card card-pad">
          <div className="tile-label" style={{ marginBottom: 8 }}>Calldata flags (independent of the descriptor)</div>
          {r.flags.map((f) => (
            <div className="flag" key={f.id}>
              {f.title}
              <div style={{ fontWeight: 400, marginTop: 2 }}>{f.detail}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid-2">
        <div className="card card-pad">
          <div className="tile-label">Readable intent (ERC-7730)</div>
          {d === null && !r.displayError && <p className="muted">Rendering…</p>}
          {r.displayError && <div className="callout callout-red" style={{ marginTop: 8 }}>Could not render: {r.displayError}</div>}
          {d && (
            <>
              {rejected ? (
                <div className="callout callout-red" style={{ marginTop: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>Descriptor rejected: integrity check failed</div>
                  <div className="small" style={{ marginTop: 4 }}>
                    <span className="mono">{rejected.path}</span> doesn't match the hash published on Arkiv, so Argos
                    renders nothing from it (raw calldata only).
                  </div>
                  <div className="small mono" style={{ marginTop: 4, wordBreak: "break-all" }}>expected {rejected.expectedHash}</div>
                  <div className="small mono" style={{ wordBreak: "break-all" }}>{rejected.error?.match(/got (0x[0-9a-f]+)/)?.[0] ?? ""}</div>
                </div>
              ) : intent ? (
                <div className="intent">{intent}</div>
              ) : (
                <div className="intent muted">No descriptor for this contract</div>
              )}
              {d.fields && d.fields.length > 0 && (
                <dl className="fields">
                  {d.fields
                    .flatMap((f) => ("fields" in f ? f.fields : [f]))
                    .flatMap((f, i) => [<dt key={`${i}-t`}>{f.label}</dt>, <dd key={`${i}-d`}>{f.value}</dd>])}
                </dl>
              )}
              {d.rawCalldataFallback && (
                <div className="small" style={{ marginTop: 10 }}>
                  <div className="muted">Raw fallback: selector <code>{d.rawCalldataFallback.selector}</code></div>
                  {d.rawCalldataFallback.args.map((a, i) => <div key={i} className="mono" style={{ wordBreak: "break-all" }}>arg {i}: {a}</div>)}
                </div>
              )}
              {d.warnings?.map((w) => <div key={w.code + w.message} className="note note-warn">{w.code}: {w.message}</div>)}
            </>
          )}
        </div>

        <div className="card card-pad">
          <div className="tile-label">Descriptor provenance</div>
          <div className={`note ${r.provenance.source === "arkiv-bulk" ? "muted" : "note-warn"}`} style={{ marginTop: 6 }}>
            {r.provenance.source === "bundled" ? "Source: bundled index" : "Source: Arkiv registry mirror"} · {r.provenance.note}
          </div>
          {r.descriptor ? (
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>registry file</dt><dd className="mono">{r.descriptor.path}</dd>
              <dt>on Arkiv / Swarm</dt>
              <dd>
                {r.descriptor.arkivKey ? <ArkivLink entityKey={r.descriptor.arkivKey} label="dg_descriptor entity" /> : <span className="muted">bundled index</span>}
                {r.descriptor.swarmRef ? <> · <SwarmLink swarmRef={r.descriptor.swarmRef} label={`Swarm ${short(r.descriptor.swarmRef, 8, 6)}`} /></> : <span className="muted"> · not on Swarm</span>}
              </dd>
              <dt>registry commit</dt><dd className="mono">{r.descriptor.commit.slice(0, 10)}</dd>
              <dt>ERC-8176 hash</dt><dd className="mono" title={r.descriptor.descriptorHash ?? ""}>{r.descriptor.descriptorHash ? short(r.descriptor.descriptorHash, 12, 8) : "—"}</dd>
              <dt>attestation</dt>
              <dd>
                {r.descriptor.attestation === "valid" ? "auditor attestation signs this exact descriptor" : r.descriptor.attestation === "stale" ? <b>attestation exists but signs different content (stale)</b> : "none in registry"}
              </dd>
              <dt>vs baseline</dt>
              <dd>{hashMatches === null ? <span className="muted">baseline records no descriptor hash</span> : hashMatches ? "same descriptor as at baseline" : <b>descriptor changed since baseline</b>}</dd>
            </dl>
          ) : (
            <p className="muted small">The registry mirror has no calldata descriptor for this contract.</p>
          )}
          {r.fetches.length > 0 && (
            <>
              <div className="small muted" style={{ marginTop: 10 }}>Files fetched {routeLabel(transport.mode)}, each checked against the keccak256 on Arkiv:</div>
              <ul className="reason-list small">
                {r.fetches.map((f, i) => (
                  <li key={`${f.path}-${i}`} style={{ color: f.ok ? undefined : f.fellBack ? "var(--warn-fg)" : "var(--bad-bg)" }}>
                    {f.ok ? "✓" : f.fellBack ? "↷" : "✗"} <span className={`source-tag source-${f.via}`}>{f.via === "swarm" ? "Swarm" : "registry"}</span>{" "}
                    <a className="mono" href={f.url} target="_blank" rel="noreferrer">{f.path}</a>
                    {f.ok && f.via === "swarm" ? " · resolved JCS bytes match the ERC-8176 hash on Arkiv" : ""}
                    {f.error ? `: ${f.error}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GuardPanel({ g }: { g: GuardSim }) {
  const impl = (a: string) => <AddressLink chainId={GUARD_DEMO.chainId} address={a} />;
  return (
    <div className={`card card-pad ${g.state === "reverted" ? "tile-red" : ""}`}>
      <div className="tile-label">Check-and-call guard · controlled demo</div>
      <p className="small muted" style={{ margin: "6px 0 10px" }}>
        This proxy's own fixed code reports its implementation, so a guard contract can check it and make the call in the same
        transaction: an upgrade can't land in between. Only this demo proxy supports it; registry contracts don't. The target sees
        the guard as the sender. Simulated with <code>eth_call</code>; nothing is sent.
      </p>
      <dl className="kv">
        <dt>send to</dt><dd>{impl(GUARD_DEMO.guard)} <span className="muted">(ArgosGuard)</span></dd>
        <dt>expected implementation</dt><dd>{impl(g.expected)} <span className="muted">(the Argos baseline on Arkiv)</span></dd>
        <dt>result now</dt>
        <dd>
          {g.state === "ok" && <b style={{ color: "var(--ok-bg)" }}>would succeed: implementation matches the baseline (block {g.block.toString()})</b>}
          {g.state === "reverted" && (
            <b style={{ color: "var(--bad-bg)" }}>
              would revert: ImplementationChanged. Live implementation {impl(g.actual)} ≠ baseline. The call would not run.
            </b>
          )}
          {g.state === "error" && <span className="muted">simulation failed: {g.error}</span>}
        </dd>
      </dl>
      <div className="hex small" style={{ marginTop: 8 }} title="checkAndCall(proxy, expectedImplementation, data)">{g.guardedData}</div>
    </div>
  );
}

function LiveLine({ live }: { live: Result["live"] }) {
  if (live.state === "not-run") return <span className="small muted">No live check (not monitored)</span>;
  if (live.state === "pending") return <span className="small muted">Live check {live.route}…</span>;
  if (live.state === "failed") return <span className="small" style={{ color: "var(--bad-bg)" }}>Live check failed {live.route}: {live.error}</span>;
  return (
    <span className="small muted">
      Live check at block {live.block.toString()} · {live.ms} ms · {live.route}
    </span>
  );
}
