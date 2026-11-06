/**
 * Browse the ERC-7730 registry mirror on Arkiv with real Arkiv queries (no downloaded JSON):
 * filters become `where` predicates on indexed attributes, always restricted to our writer.
 */
import { useMemo, useState } from "react";
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, eq, or, type Expression } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import { DeploymentSchema, DescriptorSchema, TRUSTED_CREATORS } from "@driftguard/core";
import { http } from "viem";
import { toDeployment, toDescriptor, type MirrorDeployment, type MirrorDescriptor } from "../lib/mirror.ts";
import type { RegistryManifest } from "../lib/descriptors.ts";
import { ARKIV_EXPLORER } from "../lib/config.ts";
import { AddressLink, ArkivLink, SwarmLink, short } from "../components/common.tsx";

const client = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http(undefined, { retryCount: 0, timeout: 20_000 }) });

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum", 10: "Optimism", 56: "BNB Chain", 100: "Gnosis", 130: "Unichain", 137: "Polygon", 146: "Sonic", 324: "zkSync",
  1101: "Polygon zkEVM", 5000: "Mantle", 8453: "Base", 34443: "Mode", 42161: "Arbitrum", 42220: "Celo", 43114: "Avalanche",
  59144: "Linea", 80094: "Berachain", 81457: "Blast", 534352: "Scroll", 11155111: "Sepolia",
};
const chainLabel = (id: number) => `${CHAIN_NAMES[id] ?? "chain"} (${id})`;
const PROXY_KINDS = ["eip1967", "beacon", "diamond", "safe", "none", "no-code", "unknown", "unchecked"];
const PAGE = 50;
/** Upper bound for protocol/kind queries, to stay well inside the keyless Arkiv budget. */
const MAX_ROWS = 500;

interface Filters {
  chain: string;
  protocol: string;
  kind: string;
  proxyKind: string;
  monitoredOnly: boolean;
}
interface Row extends MirrorDeployment {
  descriptor?: MirrorDescriptor;
}

// Filters are composed at runtime, so the schema-level type check of `where` can't see them;
// the SDK still validates every predicate against the schema when the query is sent.
type Expr = Expression;
const all = (xs: Expr[]): never | undefined => (xs.length === 0 ? undefined : ((xs.length === 1 ? xs[0] : and(xs)) as never));

export function BrowseMirrorScreen({ manifest }: { manifest: RegistryManifest | null }) {
  const [f, setF] = useState<Filters>({ chain: "1", protocol: "", kind: "", proxyKind: "", monitoredOnly: false });
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queryText, setQueryText] = useState<string[]>([]);
  const [stats, setStats] = useState<{ queries: number; ms: number; more: boolean; capped?: boolean } | null>(null);
  const [offset, setOffset] = useState(0);

  // Filter options from the bundled index (same pinned commit as the mirror).
  const options = useMemo(() => {
    if (!manifest) return { chains: [1], protocols: [] as string[] };
    const chains = [...new Set(Object.keys(manifest.calldataIndex).map((k) => Number(k.split(":")[1])))].sort((a, b) => a - b);
    const protocols = [...new Set(Object.values(manifest.descriptors).map((d) => d.entity))].sort();
    return { chains, protocols };
  }, [manifest]);

  async function run(nextOffset = 0) {
    setBusy(true);
    setError(null);
    const t0 = performance.now();
    let queries = 0;
    const text: string[] = [];
    try {
      const depWhere: Expr[] = [];
      if (f.chain) depWhere.push(eq("chain_id", u64(BigInt(f.chain))));
      if (f.proxyKind) depWhere.push(eq("proxy_kind", f.proxyKind));
      if (f.monitoredOnly) depWhere.push(eq("monitored", true));
      const depText = [f.chain && `chain_id = ${f.chain}`, f.proxyKind && `proxy_kind = "${f.proxyKind}"`, f.monitoredOnly && "monitored = true"].filter(Boolean);

      let deployments: MirrorDeployment[] = [];
      let more = false;
      let capped = false;
      const descByHash = new Map<string, MirrorDescriptor>();

      if (f.protocol || f.kind) {
        // 1) descriptors matching protocol/kind → their hashes
        const descWhere: Expr[] = [];
        if (f.protocol) descWhere.push(eq("entity_dir", f.protocol));
        if (f.kind) descWhere.push(eq("kind", f.kind));
        text.push(`dg_descriptor WHERE ${[f.protocol && `entity_dir = "${f.protocol}"`, f.kind && `kind = "${f.kind}"`].filter(Boolean).join(" AND ")} CREATED BY writer`);
        queries++;
        const descs = (await client.select().from(DescriptorSchema).where(all(descWhere)!).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(100).fetch()).entities.map((r) =>
          toDescriptor(r as never),
        );
        descs.forEach((d) => descByHash.set(d.descriptorHash, d));
        const hashes = [...descByHash.keys()].filter(Boolean);
        if (hashes.length > 60) throw new Error(`${hashes.length} descriptors match: narrow the filter (add a protocol or kind).`);
        // 2) deployments of those descriptors (OR of hashes, 15 per query)
        for (let i = 0; i < hashes.length; i += 15) {
          const chunk = hashes.slice(i, i + 15);
          const hashExpr: Expr = chunk.length === 1 ? eq("descriptor_hash", chunk[0]!) : or(chunk.map((h) => eq("descriptor_hash", h)));
          // page through this chunk's matches (Arkiv pages hold at most 100 rows)
          for (let o = 0; deployments.length < MAX_ROWS; ) {
            queries++;
            const page = await client.select().from(DeploymentSchema).where(all([...depWhere, hashExpr])!).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(100).offset(o).fetch();
            deployments.push(...page.entities.map((r) => toDeployment(r as never)));
            const covered = page.entities.length + page.skipped;
            if (covered < 100) break;
            o += covered;
          }
          if (deployments.length >= MAX_ROWS) {
            capped = true;
            break;
          }
        }
        text.push(`dg_deployment WHERE ${[...depText, `descriptor_hash IN (${hashes.length} hashes)`].join(" AND ")} CREATED BY writer`);
      } else {
        // deployments page with chain / proxy kind / monitored filters
        queries++;
        const w = all(depWhere);
        const q = client.select().from(DeploymentSchema);
        const page = await (w ? q.where(w) : q).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(PAGE).offset(nextOffset).fetch();
        deployments = page.entities.map((r) => toDeployment(r as never));
        more = page.entities.length + page.skipped >= PAGE;
        text.push(`dg_deployment ${depText.length ? `WHERE ${depText.join(" AND ")} ` : ""}CREATED BY writer ORDER BY $key LIMIT ${PAGE} OFFSET ${nextOffset}`);
        // descriptors for this page (OR of hashes)
        const hashes = [...new Set(deployments.map((d) => d.descriptorHash))];
        for (let i = 0; i < hashes.length; i += 15) {
          const chunk = hashes.slice(i, i + 15);
          const hashExpr: Expr = chunk.length === 1 ? eq("descriptor_hash", chunk[0]!) : or(chunk.map((h) => eq("descriptor_hash", h)));
          queries++;
          (await client.select().from(DescriptorSchema).where(hashExpr as never).createdBy(TRUSTED_CREATORS.writer).limit(100).fetch()).entities
            .map((r) => toDescriptor(r as never))
            .forEach((d) => descByHash.set(d.descriptorHash, d));
        }
        if (hashes.length) text.push(`dg_descriptor WHERE descriptor_hash IN (${hashes.length} hashes) CREATED BY writer`);
      }
      const out = deployments.map((d) => ({ ...d, descriptor: descByHash.get(d.descriptorHash) }));
      setRows(nextOffset ? [...rows, ...out] : out);
      setOffset(nextOffset);
      setQueryText(text);
      setStats({ queries, ms: Math.round(performance.now() - t0), more, capped });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(/429/.test(msg) ? "Arkiv rate-limited this browser's keyless reads; try again in a few minutes." : msg.split("\n")[0]!);
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((x) => ({ ...x, [k]: v }));

  return (
    <section>
      <h1 className="section-title">Browse the registry mirror</h1>
      <p className="section-sub">
        The ERC-7730 registry, mirrored to Arkiv by the importer: one <code>dg_descriptor</code> per registry file and one{" "}
        <code>dg_deployment</code> per (chain, contract, descriptor). Each filter below is an Arkiv query on an indexed attribute,
        restricted to our writer{" "}
        <a className="addr" href={`${ARKIV_EXPLORER}/address/${TRUSTED_CREATORS.writer}`} target="_blank" rel="noreferrer">{short(TRUSTED_CREATORS.writer)}</a>.
      </p>

      <div className="card card-pad">
        <div className="filters">
          <div>
            <label htmlFor="f-chain">Chain</label>
            <select id="f-chain" value={f.chain} onChange={(e) => set("chain", e.target.value)}>
              <option value="">All chains</option>
              {options.chains.map((c) => <option key={c} value={c}>{chainLabel(c)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="f-protocol">Protocol</label>
            <select id="f-protocol" value={f.protocol} onChange={(e) => set("protocol", e.target.value)}>
              <option value="">Any protocol</option>
              {options.protocols.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="f-kind">Descriptor kind</label>
            <select id="f-kind" value={f.kind} onChange={(e) => set("kind", e.target.value)}>
              <option value="">Any kind</option>
              <option value="calldata">calldata</option>
              <option value="eip712">eip712</option>
            </select>
          </div>
          <div>
            <label htmlFor="f-proxy">Proxy kind</label>
            <select id="f-proxy" value={f.proxyKind} onChange={(e) => set("proxyKind", e.target.value)}>
              <option value="">Any</option>
              {PROXY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.monitoredOnly} onChange={(e) => set("monitoredOnly", e.target.checked)} /> Monitored only
          </label>
          <button className="btn btn-primary" onClick={() => void run(0)} disabled={busy}>{busy ? "Querying…" : "Query Arkiv"}</button>
        </div>
        <p className="small muted" style={{ margin: "10px 0 0" }}>
          Proxy kind is classified for Ethereum mainnet deployments only; other chains show <code>unchecked</code>.
        </p>
      </div>

      {error && <div className="callout callout-red" style={{ marginTop: 12 }}>{error}</div>}

      {queryText.length > 0 && (
        <div className="hex small" style={{ marginTop: 12 }}>
          {queryText.map((q) => <div key={q}>{q}</div>)}
          {stats && <div className="muted">→ {rows.length} rows{stats.capped ? ` (first ${MAX_ROWS}; narrow the filter for the rest)` : ""} · {stats.queries} Arkiv {stats.queries === 1 ? "query" : "queries"} · {stats.ms} ms</div>}
        </div>
      )}

      {rows.length > 0 && (
        <div className="card table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr><th>Chain</th><th>Contract</th><th>Protocol</th><th>Descriptor</th><th>Kind</th><th>Proxy kind</th><th>Monitored</th><th>Attestation</th><th>Arkiv · Swarm</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="small">{chainLabel(r.chainId)}</td>
                  <td><AddressLink chainId={r.chainId} address={r.address} /></td>
                  <td>{r.descriptor?.entity ?? "—"}</td>
                  <td className="small mono" title={r.descriptor ? `${r.descriptor.path}\nERC-8176 ${r.descriptor.descriptorHash}\ncommit ${r.descriptor.commit}` : ""}>
                    {r.descriptor ? r.descriptor.path.replace(/^registry\/[^/]+\//, "") : short(r.descriptorHash, 10, 6)}
                  </td>
                  <td><span className="kind">{r.descriptor?.kind ?? "?"}</span></td>
                  <td><span className="kind">{r.proxyKind}</span></td>
                  <td>{r.monitored ? "yes" : ""}</td>
                  <td className="small">{r.descriptor?.attestation === "valid" ? "valid" : r.descriptor?.attestation === "stale" ? <b style={{ color: "var(--warn-fg)" }}>stale</b> : ""}</td>
                  <td className="small nowrap">
                    <ArkivLink entityKey={r.key} label="deployment" />
                    {r.descriptor && <> · <ArkivLink entityKey={r.descriptor.key} label="descriptor" /></>}
                    {r.descriptor?.storageMode === "swarm" && r.descriptor.swarmRef && <> · <SwarmLink swarmRef={r.descriptor.swarmRef} /></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {stats?.more && (
        <button className="btn" style={{ marginTop: 12 }} onClick={() => void run(offset + PAGE)} disabled={busy}>Load {PAGE} more</button>
      )}
      {stats && rows.length === 0 && !error && <p className="muted" style={{ marginTop: 12 }}>No rows match.</p>}
    </section>
  );
}
