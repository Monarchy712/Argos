import { useEffect, useMemo, useState } from "react";
import { primeNym } from "./lib/transport.ts";
import { buildRows, findRow, useArkiv, useManifest } from "./lib/rows.ts";
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
  const now = useNow();
  const [network, setNetwork] = useState<NetworkFilter>("all");

  // Boot the Nym worker while the viewer reads this page, so the first live read doesn't wait.
  useEffect(() => primeNym(), []);

  const allRows = useMemo(() => (arkiv.snap ? buildRows(arkiv.snap, manifest, now) : []), [arkiv.snap, manifest, now]);
  const rows = useMemo(() => (network === "all" ? allRows : allRows.filter((r) => r.chainId === network)), [allRows, network]);

  // Moving between pages starts at the top; switching tabs inside a contract does not.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route.name, route.name === "contract" ? route.address : null]);

  return (
    <Shell route={route} rows={allRows} network={network} setNetwork={setNetwork}>
      {route.name === "overview" && <OverviewScreen rows={rows} arkiv={arkiv} now={now} network={network} />}
      {route.name === "contracts" && (
        <ContractsScreen rows={rows} arkiv={arkiv} now={now} network={network} setNetwork={setNetwork} />
      )}
      {route.name === "add" && <AddContractScreen rows={allRows} manifest={manifest} />}
      {route.name === "how" && <HowItWorksScreen />}
      {route.name === "contract" && (
        <ContractWorkspace
          row={findRow(allRows, route.chainId, route.address)}
          chainId={route.chainId}
          address={route.address}
          tab={route.tab}
          focusEvent={route.event}
          arkiv={arkiv}
          manifest={manifest}
          now={now}
        />
      )}
      <Toasts />
    </Shell>
  );
}
