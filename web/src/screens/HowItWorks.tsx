/**
 * About / How it works: one diagram of the data flow, what each badge means, what Argos does not
 * do, and links to check every claim yourself (Arkiv entities, a Swarm reference, the repo).
 */
import { StatusBadge, ArkivLink, SwarmLink, short } from "../components/common.tsx";
import { ARKIV_EXPLORER, TRUSTED_CREATORS } from "../lib/config.ts";

/** Example rows, also cited in arkiv/swarm.md: Aave v3 Pool's descriptor. */
const EXAMPLE = {
  descriptorKey: "0x495d23d3c4677d440698729634c5557cbd71b106abf9d1d805e10cf57bdee4f8",
  swarmRef: "7d65ee6ba97951c31444de4d7e88ce768fc8eaf1887966e3b451c10b2af63a04",
  descriptorHash: "0xf11301c71b26b892d49d820260f565cc776d8d54c89538f6b439272519322683",
};
const REPO = "https://github.com/Monarchy712/Argos";

function Box({ x, y, w, h, title, lines, tone }: { x: number; y: number; w: number; h: number; title: string; lines: string[]; tone: "src" | "proc" | "store" | "user" }) {
  return (
    <g className={`dg-box dg-${tone}`}>
      <rect x={x} y={y} width={w} height={h} rx={10} />
      <text x={x + 14} y={y + 24} className="dg-title">{title}</text>
      {lines.map((l, i) => (
        <text key={l} x={x + 14} y={y + 46 + i * 19} className="dg-line">{l}</text>
      ))}
    </g>
  );
}

function Arrow({ d, label, lx, ly }: { d: string; label?: string; lx?: number; ly?: number }) {
  return (
    <g className="dg-arrow">
      <path d={d} markerEnd="url(#dg-head)" />
      {label && <text x={lx} y={ly} className="dg-label">{label}</text>}
    </g>
  );
}

function Diagram() {
  return (
    <svg viewBox="0 0 1000 470" className="diagram" role="img" aria-label="Argos data flow: the registry and Ethereum feed the importer and watcher, which write to Swarm and Arkiv; the browser reads Arkiv and Swarm, checks hashes, and shows a status.">
      <defs>
        <marker id="dg-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="dg-headfill" />
        </marker>
      </defs>
      <Box x={20} y={16} w={300} h={78} tone="src" title="ERC-7730 registry (EF, CC0)" lines={["768 descriptor files, pinned commit"]} />
      <Box x={680} y={16} w={300} h={78} tone="src" title="Ethereum" lines={["proxy slots + Upgraded events"]} />

      <Box x={20} y={140} w={300} h={98} tone="proc" title="importer  (writer key)" lines={["resolve includes → JCS bytes", "ERC-8176 hash, computed twice", "attestation check vs sigs/"]} />
      <Box x={680} y={140} w={260} h={98} tone="proc" title="watcher  (watcher key)" lines={["events from a cursor + slot reads", "every 60 s; writes every 120 s", "or at once on a change"]} />

      <Box x={20} y={284} w={240} h={78} tone="store" title="Swarm" lines={["resolved descriptor bytes (746)"]} />
      <Box x={300} y={284} w={640} h={78} tone="store" title="Arkiv (Rabdi)" lines={["writer: dg_descriptor (+ swarm_ref) · dg_deployment · dg_baseline", "watcher: dg_current_state (expires in 10 min) · dg_latest_change"]} />

      <Box x={190} y={398} w={620} h={62} tone="user" title="Your browser: Argos" lines={["bytes must hash to the Arkiv value · your own live slot read → badge"]} />

      <Arrow d="M170 94 V140" />
      <Arrow d="M810 94 V140" />
      <Arrow d="M120 238 V284" label="upload" lx={128} ly={266} />
      <Arrow d="M290 238 Q 330 262 400 284" label="metadata + swarm_ref" lx={318} ly={262} />
      <Arrow d="M810 238 V284" label="state, changes" lx={818} ly={266} />
      <Arrow d="M140 362 Q 150 392 250 398" label="GET /bytes/ref" lx={40} ly={392} />
      <Arrow d="M640 362 V398" label="bulk read, by $creator" lx={648} ly={388} />
      <Arrow d="M965 94 V429 H812" label="live read" lx={822} ly={448} />
    </svg>
  );
}

export function HowItWorksScreen() {
  return (
    <section className="stack">
      <h1 className="section-title">How Argos works</h1>
      <p className="section-sub">
        ERC-7730 descriptors tell wallets how to show a transaction in plain language. They are bound to a contract address. For an
        upgradeable proxy that address stays the same when the code behind it changes, so a wallet keeps showing a confident,
        readable intent for code nobody reviewed. <b>314 of 652</b> mainnet contracts in the registry (48%) are such proxies. Argos
        records each monitored contract&apos;s code at a baseline, watches for upgrades, and publishes what it sees on Arkiv, where
        anyone can check it.
      </p>

      <div className="card card-pad">
        <Diagram />
      </div>

      <div className="grid-2">
        <div className="card card-pad">
          <div className="tile-label">What the badges mean</div>
          <dl className="legend">
            <dt><StatusBadge status="GREEN" /></dt>
            <dd>A fresh watcher record (at most 5 minutes old) matches the baseline, and your live read agrees. It means <i>no change seen as of block N</i>, not &quot;safe&quot;.</dd>
            <dt><StatusBadge status="RED" /></dt>
            <dd>The watcher or your live read shows code that differs from the baseline. Check whether the descriptor still describes this code. It never means &quot;malicious&quot;.</dd>
            <dt><StatusBadge status="NOT_VERIFIED" /></dt>
            <dd>No record, an expired or stale record (for example the watcher stopped), an unsupported proxy, a failed live read, or a contract Argos doesn&apos;t monitor. The reason is always shown.</dd>
          </dl>
        </div>
        <div className="card card-pad">
          <div className="tile-label">Check it yourself</div>
          <ul className="reason-list small">
            <li>
              Trusted writers: baselines and mirror{" "}
              <a className="addr" href={`${ARKIV_EXPLORER}/address/${TRUSTED_CREATORS.writer}`} target="_blank" rel="noreferrer">{short(TRUSTED_CREATORS.writer)}</a>, watcher{" "}
              <a className="addr" href={`${ARKIV_EXPLORER}/address/${TRUSTED_CREATORS.watcher}`} target="_blank" rel="noreferrer">{short(TRUSTED_CREATORS.watcher)}</a>. Rows from anyone else are ignored.
            </li>
            <li>
              Example: Aave v3 Pool&apos;s descriptor <ArkivLink entityKey={EXAMPLE.descriptorKey} label="on Arkiv" /> points to its bytes{" "}
              <SwarmLink swarmRef={EXAMPLE.swarmRef} label="on Swarm" />. keccak256 of those bytes is{" "}
              <span className="mono" title={EXAMPLE.descriptorHash}>{short(EXAMPLE.descriptorHash, 10, 8)}</span>, the hash on the Arkiv row.
            </li>
            <li>
              Without this app: <code>node scripts/show-arkiv.ts</code> prints every status from Arkiv, and{" "}
              <code>node scripts/query-mirror.ts stale</code> queries the registry mirror. No keys needed.
            </li>
            <li>
              Source (MIT): <a href={REPO} target="_blank" rel="noreferrer">{REPO.replace("https://", "")}</a>
            </li>
          </ul>
          <div className="tile-label" style={{ marginTop: 14 }}>What Argos does not do</div>
          <ul className="reason-list small">
            <li>It doesn&apos;t block transactions or judge whether an upgrade is good or bad.</li>
            <li>A status is &quot;as of block N&quot;: an upgrade can still land between your check and your transaction.</li>
            <li>Live reads are direct RPC by default (not anonymized). Nym is opt-in and fails closed.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
