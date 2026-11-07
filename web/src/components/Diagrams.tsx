/**
 * Original diagrams for How It Works.
 *
 * Drawn, not illustrated, and drawn from the real mechanism: the storage slot Argos reads, the
 * comparison it makes, the 4-byte selectors it diffs, and the chain of references that lets
 * someone else check the claim. No third-party logos — they would be someone else's marks, and
 * fetching them would hand a visitor's IP to a CDN on a page about not being observed.
 *
 * Every diagram is pure SVG using the app's own tokens, so it themes with the product and costs
 * nothing to load.
 */

/** 1 — why the address is not the code: one address, two different implementations over time. */
export function DiagramProxy() {
  return (
    <svg viewBox="0 0 560 190" className="diagram" role="img"
         aria-label="A proxy address keeps the same address while the implementation behind it is replaced.">
      <rect x="14" y="68" width="150" height="54" rx="8" className="node" />
      <text x="89" y="90" className="label" textAnchor="middle">The address you sign</text>
      <text x="89" y="107" className="mono-label" textAnchor="middle">0x4e81…6275b</text>

      <path d="M170 95 H228" className="flowline" />
      <text x="199" y="84" className="mono-label" textAnchor="middle">delegates</text>

      <rect x="236" y="22" width="150" height="50" rx="8" className="node ok" />
      <text x="311" y="43" className="label" textAnchor="middle">Implementation A</text>
      <text x="311" y="59" className="mono-label" textAnchor="middle">the code you reviewed</text>

      <rect x="236" y="118" width="150" height="50" rx="8" className="node bad" />
      <text x="311" y="139" className="label" textAnchor="middle">Implementation B</text>
      <text x="311" y="155" className="mono-label" textAnchor="middle">the code running now</text>

      <path d="M228 95 L236 47" className="wire" />
      <path d="M228 95 L236 143" className="flowline" />

      <path d="M396 47 H470" className="wire" strokeDasharray="4 4" />
      <path d="M396 143 H470" className="wire" strokeDasharray="4 4" />
      <text x="478" y="51" className="mono-label">reviewed</text>
      <text x="478" y="147" className="mono-label">not reviewed</text>

      <text x="14" y="184" className="mono-label">The address never changed. A wallet cannot tell the difference.</text>
    </svg>
  );
}

/** 2 — what Argos actually reads: the EIP-1967 slot, hashed into one code identity. */
export function DiagramRead() {
  return (
    <svg viewBox="0 0 560 170" className="diagram" role="img"
         aria-label="Argos reads the proxy's implementation slot, admin and codehash, and hashes them into one code identity.">
      <rect x="14" y="20" width="168" height="130" rx="8" className="node" />
      <text x="98" y="42" className="label" textAnchor="middle">Contract storage</text>

      <rect x="28" y="54" width="140" height="26" rx="5" className="node" />
      <text x="36" y="71" className="mono-label">slot 0x360894…bbc</text>
      <rect x="28" y="86" width="140" height="26" rx="5" className="node" />
      <text x="36" y="103" className="mono-label">admin slot</text>
      <rect x="28" y="118" width="140" height="22" rx="5" className="node" />
      <text x="36" y="133" className="mono-label">codehash</text>

      <path d="M188 85 H262" className="flowline" />
      <text x="225" y="75" className="mono-label" textAnchor="middle">eth_call</text>

      <rect x="270" y="58" width="130" height="54" rx="8" className="node accent" />
      <text x="335" y="80" className="label" textAnchor="middle">keccak256</text>
      <text x="335" y="97" className="mono-label" textAnchor="middle">one identity</text>

      <path d="M406 85 H462" className="wire" />
      <rect x="462" y="62" width="86" height="46" rx="8" className="node" />
      <text x="505" y="80" className="mono-label" textAnchor="middle">0x998da5…</text>
      <text x="505" y="96" className="mono-label" textAnchor="middle">de5f</text>

      <text x="14" y="166" className="mono-label">Identical identity means identical code path. Nothing else is inferred.</text>
    </svg>
  );
}

/** 3 — the comparison: baseline against the latest observation, and the three outcomes. */
export function DiagramCompare() {
  return (
    <svg viewBox="0 0 560 200" className="diagram" role="img"
         aria-label="The baseline identity is compared against the observed identity, producing matches, changed, or not verified.">
      <rect x="14" y="30" width="150" height="48" rx="8" className="node" />
      <text x="89" y="50" className="label" textAnchor="middle">Baseline</text>
      <text x="89" y="66" className="mono-label" textAnchor="middle">what you trusted</text>

      <rect x="14" y="112" width="150" height="48" rx="8" className="node" />
      <text x="89" y="132" className="label" textAnchor="middle">Observed</text>
      <text x="89" y="148" className="mono-label" textAnchor="middle">at block N</text>

      <path d="M170 54 Q210 54 214 86" className="wire" />
      <path d="M170 136 Q210 136 214 104" className="wire" />

      <circle cx="238" cy="95" r="24" className="node accent" />
      <text x="238" y="100" className="label" textAnchor="middle">=?</text>

      <path d="M264 86 H318" className="flowline" />
      <path d="M264 95 H318" className="wire" />
      <path d="M264 104 H318" className="wire" />

      {/* Sublabels are kept short enough to sit inside the 220-unit box at 10px mono (~6 units a
          character). SVG text does not wrap, so anything longer is silently clipped. */}
      <rect x="326" y="14" width="220" height="42" rx="8" className="node ok" />
      <text x="340" y="33" className="label">Matches baseline</text>
      <text x="340" y="48" className="mono-label">no change at block N</text>

      <rect x="326" y="68" width="220" height="42" rx="8" className="node bad" />
      <text x="340" y="87" className="label">Changed</text>
      <text x="340" y="102" className="mono-label">different code now</text>

      <rect x="326" y="122" width="220" height="42" rx="8" className="node" />
      <text x="340" y="141" className="label">Not verified</text>
      <text x="340" y="156" className="mono-label">no fresh reading</text>

      <text x="14" y="190" className="mono-label">Every answer carries the block it was true at.</text>
    </svg>
  );
}

/** 4 — the selector diff, which is what "what changed" actually means here. */
export function DiagramSelectors() {
  return (
    <svg viewBox="0 0 560 160" className="diagram" role="img"
         aria-label="Four-byte function selectors are recovered from both implementations' bytecode and compared.">
      <rect x="14" y="24" width="160" height="112" rx="8" className="node" />
      <text x="94" y="45" className="label" textAnchor="middle">Previous bytecode</text>
      <text x="30" y="68" className="mono-label">0xd09de08a</text>
      <text x="30" y="86" className="mono-label">0x3fa4f245</text>
      <text x="30" y="104" className="mono-label" fill="var(--fail)">0x03df179c</text>
      <text x="30" y="122" className="mono-label">0x54fd4d50</text>

      <path d="M182 80 H236" className="flowline" />
      <text x="209" y="70" className="mono-label" textAnchor="middle">diff</text>

      <rect x="244" y="24" width="160" height="112" rx="8" className="node" />
      <text x="324" y="45" className="label" textAnchor="middle">New bytecode</text>
      <text x="260" y="68" className="mono-label">0xd09de08a</text>
      <text x="260" y="86" className="mono-label">0x3fa4f245</text>
      <text x="260" y="104" className="mono-label" fill="var(--pass)">0xfe4b84df</text>
      <text x="260" y="122" className="mono-label">0x54fd4d50</text>

      <rect x="422" y="40" width="126" height="34" rx="6" className="node bad" />
      <text x="436" y="61" className="mono-label" fill="var(--fail)">− 1 removed</text>
      <rect x="422" y="84" width="126" height="34" rx="6" className="node ok" />
      <text x="436" y="105" className="mono-label" fill="var(--pass)">+ 1 added</text>

      <text x="14" y="154" className="mono-label">A PUSH4 scan: a superset of the ABI, never a decompiler.</text>
    </svg>
  );
}

/** 5 — the evidence chain: why you do not have to take Argos's word for any of it. */
export function DiagramEvidence() {
  return (
    <svg viewBox="0 0 560 150" className="diagram" role="img"
         aria-label="Each claim links to an Arkiv record, which references Swarm content addressed by hash.">
      <rect x="14" y="48" width="118" height="52" rx="8" className="node accent" />
      <text x="73" y="70" className="label" textAnchor="middle">Argos says</text>
      <text x="73" y="86" className="mono-label" textAnchor="middle">“this changed”</text>

      <path d="M138 74 H190" className="flowline" />

      <rect x="198" y="48" width="130" height="52" rx="8" className="node" />
      <text x="263" y="70" className="label" textAnchor="middle">Arkiv record</text>
      <text x="263" y="86" className="mono-label" textAnchor="middle">signed by a writer</text>

      <path d="M334 74 H386" className="flowline" />

      <rect x="394" y="48" width="154" height="52" rx="8" className="node" />
      <text x="471" y="70" className="label" textAnchor="middle">Swarm content</text>
      <text x="471" y="86" className="mono-label" textAnchor="middle">addressed by hash</text>

      <path d="M471 104 V124 H263 V104" className="wire" strokeDasharray="4 4" />
      <text x="367" y="138" className="mono-label" textAnchor="middle">
        hash must match, or Argos renders nothing
      </text>
    </svg>
  );
}
