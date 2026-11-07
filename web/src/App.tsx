import { useEffect, useMemo, useState } from "react";
import { buildLocalRows, buildRows, demoRows, findRow, userRows, useArkiv, useManifest } from "./lib/rows.ts";
import { useWatchlist } from "./lib/watchlist.ts";
import { useRoute } from "./lib/router.ts";
import { Shell, type NetworkFilter } from "./components/Shell.tsx";
import { Toasts, useNow } from "./components/common.tsx";
import { OverviewScreen } from "./screens/Overview.tsx";
import { ContractsScreen } from "./screens/Contracts.tsx";
import { AddContractScreen } from "./screens/AddContract.tsx";
import { HowItWorksScreen } from "./screens/HowItWorks.tsx";
import { ContractWorkspace } from "./screens/contract/Workspace.tsx";

export function App() {
  const route = useRoute();
  const arkiv = useArkiv();
  const manifest = useManifest();
  const watch = useWatchlist();
  const now = useNow();
  const [network, setNetwork] = useState<NetworkFilter>("all");

  const arkivRows = useMemo(() => (arkiv.snap ? buildRows(arkiv.snap, manifest, now) : []), [arkiv.snap, manifest, now]);
  const networkRows = useMemo(() => userRows(arkivRows), [arkivRows]);

  // Two populations, never blended:
  //   yours   — contracts you added, whether or not the publisher has written them to Arkiv.
  //   network — what the Argos watcher monitors on Arkiv, including the demo proxies.
  //
  // A contract you added that the publisher *did* write is monitored properly by the watcher, so
  // the Arkiv row wins — it carries change history, evidence and continuous coverage. One that has
  // not been published falls back to this browser's own live read, which is weaker but real, and
  // is labelled as yours. That is what replaced the old dead-end "awaiting publication" state.
  const yours = useMemo(() => {
    const local = buildLocalRows(watch.entries, watch.checks, now);
    const onArkiv = new Map(arkivRows.map((r) => [r.id, r]));
    return local.map((l) => onArkiv.get(l.id) ?? l);
  }, [watch.entries, watch.checks, arkivRows, now]);

  const byNetwork = <T extends { chainId: number }>(list: T[]) =>
    network === "all" ? list : list.filter((r) => r.chainId === network);

  const mine = useMemo(() => byNetwork(yours), [yours, network]);
  const fleet = useMemo(() => byNetwork(networkRows), [networkRows, network]);

  // A workspace link must resolve whichever population it came from.
  const lookup = useMemo(() => [...yours, ...arkivRows], [yours, arkivRows]);

  // Moving between pages starts at the top; switching tabs inside a contract does not.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route.name, route.name === "contract" ? route.address : null]);

  return (
    <Shell route={route} rows={yours} network={network} setNetwork={setNetwork}>
      {route.name === "overview" && (
        <OverviewScreen rows={mine} watch={watch} arkiv={arkiv} now={now} fleetCount={networkRows.length} />
      )}
      {route.name === "contracts" && (
        <ContractsScreen
          rows={mine}
          fleet={fleet}
          demos={demoRows(arkivRows)}
          watch={watch}
          arkiv={arkiv}
          now={now}
          network={network}
          setNetwork={setNetwork}
        />
      )}
      {route.name === "add" && <AddContractScreen rows={lookup} manifest={manifest} arkiv={arkiv} />}
      {route.name === "how" && <HowItWorksScreen />}
      {route.name === "contract" && (
        <ContractWorkspace
          row={findRow(lookup, route.chainId, route.address)}
          chainId={route.chainId}
          address={route.address}
          tab={route.tab}
          focusEvent={route.event}
          arkiv={arkiv}
          watch={watch}
          manifest={manifest}
          now={now}
        />
      )}
      <Toasts />
    </Shell>
  );
}
