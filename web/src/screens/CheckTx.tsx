import { useMemo, useState } from "react";
import { computeStatus, riskyCalldataFlags, PROXY_KINDS, type ProxyKind, type LiveEvidence, type RiskFlag, type StatusResult } from "@driftguard/core";
import { format, type DisplayModel } from "@ethereum-sourcify/clear-signing";
import { encodeFunctionData, getAddress, isAddress, isHex, parseAbi, parseTransaction, serializeTransaction, type Hex } from "viem";
import { idOf, type ArkivSnapshot } from "../lib/arkiv.ts";
import { clientFor, liveIdentity } from "../lib/chain.ts";
import { CHAINS, DEMO_PROXY } from "../lib/config.ts";
import { RegistryFallbackSource, descriptorFor, makeResolver, type FetchRecord, type RegistryManifest } from "../lib/descriptors.ts";
import { routeLabel } from "../lib/transport.ts";
import { AddressLink, StatusBadge, chainName, short, useTransport } from "../components/common.tsx";

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

interface Result {
  tx: Tx;
  flags: RiskFlag[];
  status: StatusResult;
  live: LiveEvidence & { ms?: number; route?: string };
  display: DisplayModel | null;
  displayError: string | null;
  fetches: FetchRecord[];
  descriptor: ReturnType<typeof descriptorFor>;
  baselineDescriptorHash: string | null;
}

export function CheckTxScreen({ snap, manifest }: { snap: ArkivSnapshot | null; manifest: RegistryManifest | null }) {
  const transport = useTransport();
  const [input, setInput] = useState(EXAMPLES[0]!.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
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
    const flags = riskyCalldataFlags(tx.data);
    const id = idOf(tx.chainId, tx.to);
    const baseline = snap?.baselines.find((b) => idOf(b.chainId, b.address) === id) ?? null;
    const current = snap?.current.find((c) => idOf(c.chainId, c.address) === id) ?? null;
    const change = snap?.changes.find((c) => idOf(c.chainId, c.address) === id) ?? null;
    const descriptor = manifest ? descriptorFor(manifest, tx.chainId, tx.to) : null;
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
    const source = manifest ? new RegistryFallbackSource(manifest) : null;
    const displayPromise = source
      ? format(
          { chainId: tx.chainId, to: tx.to, data: tx.data, value: tx.value },
          {
            descriptorResolverOptions: { type: "custom", resolver: makeResolver(manifest!, source) },
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
      : Promise.resolve({ display: null, displayError: "registry manifest not loaded" });

    const [live, shown] = await Promise.all([livePromise, displayPromise]);
    setResult({ ...base, live, status: evaluate(live), ...shown, fetches: source?.log ?? [] });
    setBusy(false);
  }

  return (
    <section>
      <h1 className="section-title">Check a transaction</h1>
      <p className="section-sub">
        Paste a transaction. DriftGuard shows the raw calldata, renders the readable ERC-7730 intent from a hash-checked
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
          {!snap && <div className="callout">Arkiv data is still loading; monitored status will show as Not verified until it arrives.</div>}
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
              {intent ? <div className="intent">{intent}</div> : <div className="intent muted">No descriptor for this contract</div>}
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
          {r.descriptor ? (
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>registry file</dt><dd className="mono">{r.descriptor.path}</dd>
              <dt>ERC-8176 hash</dt><dd className="mono" title={r.descriptor.descriptorHash ?? ""}>{r.descriptor.descriptorHash ? short(r.descriptor.descriptorHash, 12, 8) : "—"}</dd>
              <dt>attestation</dt><dd>{r.descriptor.attested ? "auditor attestation in registry sigs/" : "none in registry"}</dd>
              <dt>vs baseline</dt>
              <dd>{hashMatches === null ? <span className="muted">baseline has no descriptor hash yet (importer pending)</span> : hashMatches ? "same descriptor as at baseline" : <b>descriptor changed since baseline</b>}</dd>
            </dl>
          ) : (
            <p className="muted small">The registry has no descriptor for this contract.</p>
          )}
          {r.fetches.length > 0 && (
            <>
              <div className="small muted" style={{ marginTop: 10 }}>Files fetched {routeLabel(transport.mode)}, each checked against the pinned keccak256:</div>
              <ul className="reason-list small">
                {r.fetches.map((f) => (
                  <li key={f.path} style={{ color: f.ok ? undefined : "var(--bad-bg)" }}>
                    {f.ok ? "✓" : "✗"} <span className="mono">{f.path}</span>{f.error ? `: ${f.error}` : ""}
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
