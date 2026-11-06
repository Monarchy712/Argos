/**
 * The monitored-contracts table. One component for the overview and for My Contracts, so a row
 * means the same thing in both places and status never has to be re-learned.
 *
 * Column order follows the question a user actually asks: *what is the state*, *of which
 * contract*, *compared against what*, *as of when*.
 */
import { AddressLink, AsOf, Badge, Empty, SkeletonRows, StatusBadge, chainName, stripeClass } from "./common.tsx";
import { Icon } from "./icons.tsx";
import { contractHref, navigate } from "../lib/router.ts";
import type { MonitoredRow } from "../lib/rows.ts";

const isZero = (a: string) => /^0x0{40}$/i.test(a);

export function ContractTable({
  rows, now, loading, compact, emptyAction,
}: {
  rows: MonitoredRow[];
  now: number;
  loading?: boolean;
  /** overview drops the network and proxy columns; My Contracts shows everything */
  compact?: boolean;
  emptyAction?: React.ReactNode;
}) {
  const cols = compact ? 5 : 7;

  if (!loading && rows.length === 0) {
    return (
      <Empty icon="inbox" title="No contracts match" action={emptyAction}>
        Argos monitors a contract once a trusted baseline exists for it. Nothing here matches the current
        network and status filters.
      </Empty>
    );
  }

  return (
    <div className="tbl-wrap">
      <table className="tbl" style={compact ? undefined : { minWidth: 1120 }}>
        <thead>
          <tr>
            <th style={{ padding: 0, width: 3 }}><span className="sr-only">Severity</span></th>
            <th style={{ width: 200 }}>Status</th>
            <th>Contract</th>
            {!compact && <th style={{ width: 110 }}>Network</th>}
            {!compact && <th style={{ width: 170 }}>Proxy address</th>}
            <th style={{ width: 180 }}>Baseline implementation</th>
            <th style={{ width: 180 }}>Current implementation</th>
            <th style={{ width: 150 }}>Last checked</th>
            <th style={{ width: 52 }}><span className="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 && <SkeletonRows rows={5} cols={cols + 2} />}
          {rows.map((r) => {
            const href = contractHref(r.chainId, r.address, r.status.status === "RED" ? "investigate" : "overview");
            const changed = r.current && r.current.implementation.toLowerCase() !== r.baseline.implementation.toLowerCase();
            return (
              <tr
                key={r.id}
                className={stripeClass(r.status.status)}
                onClick={() => navigate(href)}
                style={{ cursor: "pointer" }}
              >
                <td className="stripe"><span /></td>

                <td>
                  <div className="stack-s">
                    <StatusBadge status={r.status.status} />
                    <span className="t-12 dim" style={{ lineHeight: 1.45 }}>{r.status.reasons[0]}</span>
                  </div>
                </td>

                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="strong">{r.protocol}</span>
                    {r.isDemo && <Badge tone="info">Demo</Badge>}
                    {r.attested && <Badge>Attested</Badge>}
                  </div>
                  <div className="t-12 dimmer" style={{ marginTop: 3 }}>
                    <span className="mono">{r.proxyKind}</span> · {r.detection}
                    {compact && <> · {chainName(r.chainId)}</>}
                  </div>
                </td>

                {!compact && <td className="t-13 dim">{chainName(r.chainId)}</td>}
                {!compact && <td><AddressLink chainId={r.chainId} address={r.address} /></td>}

                <td>
                  {r.proxyKind === "diamond" ? (
                    <span className="t-12 dimmer">facets hash (diamond)</span>
                  ) : isZero(r.baseline.implementation) ? (
                    <span className="t-12 dimmer">—</span>
                  ) : (
                    <AddressLink chainId={r.chainId} address={r.baseline.implementation} />
                  )}
                </td>

                <td>
                  {r.current ? (
                    r.proxyKind === "diamond" ? (
                      <span className="t-12 dimmer">facets hash (diamond)</span>
                    ) : (
                      <AddressLink chainId={r.chainId} address={r.current.implementation} tone={changed ? "bad" : undefined} />
                    )
                  ) : (
                    <span className="t-12" style={{ color: "var(--warn)" }}>no fresh record</span>
                  )}
                </td>

                <td>
                  {r.current ? (
                    <AsOf block={r.current.checkedBlock} at={r.current.checkedAt} now={now} prefix="" />
                  ) : (
                    <span className="asof">not checked since baseline</span>
                  )}
                </td>

                <td className="td-right">
                  <a
                    className="btn sm ghost"
                    href={href}
                    aria-label={`Open ${r.protocol}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Icon name="chevronRight" size={15} />
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
