/**
 * Hash routing, deliberately. The built app is published as a static Swarm collection and to
 * Vercel; neither can rewrite arbitrary paths to index.html for every contract address, so
 * `#/c/1/0x…/history` is the only form that survives a reload on both.
 *
 * No router dependency: the app has five route shapes and this is ~60 lines.
 */
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "overview" }
  | { name: "contracts" }
  | { name: "add" }
  | { name: "how" }
  | { name: "contract"; chainId: number; address: string; tab: ContractTab; event: string | null };

export const CONTRACT_TABS = ["overview", "history", "investigate", "evidence", "guard"] as const;
export type ContractTab = (typeof CONTRACT_TABS)[number];

export function parseHash(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, "").split("?");
  const parts = (path ?? "").split("/").filter(Boolean);
  const params = new URLSearchParams(query ?? "");

  if (parts[0] === "c" && parts[1] && parts[2]) {
    const chainId = Number(parts[1]);
    const tab = (CONTRACT_TABS as readonly string[]).includes(parts[3] ?? "") ? (parts[3] as ContractTab) : "overview";
    if (Number.isFinite(chainId) && /^0x[0-9a-fA-F]{40}$/.test(parts[2])) {
      return { name: "contract", chainId, address: parts[2].toLowerCase(), tab, event: params.get("ev") };
    }
  }
  if (parts[0] === "contracts") return { name: "contracts" };
  if (parts[0] === "add") return { name: "add" };
  if (parts[0] === "how") return { name: "how" };
  return { name: "overview" };
}

/** Build a link to a contract workspace tab (optionally focused on one change event). */
export function contractHref(chainId: number, address: string, tab: ContractTab = "overview", event?: string): string {
  const base = `#/c/${chainId}/${address.toLowerCase()}/${tab}`;
  return event ? `${base}?ev=${encodeURIComponent(event)}` : base;
}

export const navigate = (href: string) => {
  window.location.hash = href.startsWith("#") ? href.slice(1) : href;
};

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  return parseHash(hash);
}

/**
 * Hash navigation doesn't reset scroll, which is wrong when moving between pages but right when
 * switching tabs inside one contract. Callers decide.
 */
export function scrollTop() {
  window.scrollTo({ top: 0, behavior: "auto" });
}
