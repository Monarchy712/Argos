/**
 * Live verification for the contracts you added.
 *
 * This is the answer to "what is the point of Awaiting baseline publication?". The honest answer
 * was: not much on its own. A request that the server has not published yet left the contract with
 * no status at all, forever, which is a dead end rather than a safeguard.
 *
 * But the browser never needed the writer to do the core job. It can read the proxy's slots itself
 * over `eth_call`, exactly as the watcher does, and compare the result to the identity it recorded
 * at inspection time. So a contract you added is checked from the moment you add it:
 *
 *   published to Arkiv   → the watcher's record wins; continuous, independent of this browser.
 *   not published (yet)  → your own read is used, and the UI says the check is yours.
 *
 * The local path is genuinely weaker — it only observes while this page is open, so it cannot
 * catch an A→B→A that happens in between — and it is labelled as such everywhere, never shown as
 * equivalent to watcher coverage.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { PROXY_KINDS, type ProxyKind, type StatusResult } from "@driftguard/core";
import type { Address, Hex } from "viem";
import { liveIdentity } from "./chain.ts";
import { pendingStore, type PendingBaseline } from "./pending.ts";
import { routeLabel, transport } from "./transport.ts";

const idOf = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

export type LiveCheck =
  | { state: "pending" }
  | { state: "ok"; codeIdentity: Hex; implementation: Address; block: bigint; at: number; ms: number; route: string }
  | { state: "failed"; error: string; at: number; route: string };

/**
 * Status for a contract verified by this browser.
 *
 * Deliberately not core's `computeStatus`: that function's wording credits every observation to
 * the watcher ("Watcher verified at block N"), which would be a false attribution here. The rules
 * are identical — differs is RED, unconfirmed is NOT VERIFIED, never a silent pass — but the
 * sentences say who actually looked.
 */
export function localStatus(entry: PendingBaseline, live: LiveCheck): StatusResult {
  if (!(PROXY_KINDS as readonly string[]).includes(entry.proxyKind)) {
    return {
      status: "NOT_VERIFIED",
      headline: "Unsupported pattern",
      reasons: ["This contract's upgrade mechanism can't be read, so changes can't be verified."],
    };
  }
  if (live.state === "pending") {
    return { status: "NOT_VERIFIED", headline: "Checking", reasons: ["Reading the contract now."] };
  }
  if (live.state === "failed") {
    return {
      status: "NOT_VERIFIED",
      headline: "Not verified",
      reasons: [`The read failed: ${live.error}`, "Argos reports the failure rather than assuming nothing changed."],
    };
  }
  if (live.codeIdentity.toLowerCase() !== entry.codeIdentity.toLowerCase()) {
    return {
      status: "RED",
      headline: "Change detected",
      reasons: [
        `Your read at block ${live.block} returned a different code identity from the one recorded for this baseline.`,
        "Check whether the contract still does what you reviewed.",
      ],
    };
  }
  return {
    status: "GREEN",
    headline: "Matches baseline",
    reasons: [
      `Checked by this browser at block ${live.block}; the code identity matches the baseline.`,
      "No change seen at that block — not a guarantee about future blocks, and only while this page is open.",
    ],
  };
}

/**
 * The contracts you added, plus one live read each. Re-reads when the list changes and on an
 * explicit refresh. There is no polling: this only observes while the page is open, and a ticking
 * timer would imply coverage that does not exist.
 */
export function useWatchlist() {
  const entries = useSyncExternalStore(pendingStore.subscribe, pendingStore.get, pendingStore.get);
  const [checks, setChecks] = useState<Record<string, LiveCheck>>({});
  const [checking, setChecking] = useState(false);

  const verify = useCallback(async (list: PendingBaseline[]) => {
    if (list.length === 0) {
      setChecks({});
      return;
    }
    const route = routeLabel(transport.get().mode);
    setChecking(true);
    setChecks((prev) => {
      const next = { ...prev };
      for (const e of list) next[idOf(e.chainId, e.address)] ??= { state: "pending" };
      return next;
    });

    await Promise.all(
      list.map(async (e) => {
        const id = idOf(e.chainId, e.address);
        const at = Math.floor(Date.now() / 1000);
        try {
          const r = await liveIdentity(e.chainId, e.address as Address, e.proxyKind as ProxyKind);
          setChecks((p) => ({
            ...p,
            [id]: {
              state: "ok", codeIdentity: r.identityHash, implementation: r.identity.implementation,
              block: r.block, at, ms: r.ms, route,
            },
          }));
        } catch (err) {
          setChecks((p) => ({
            ...p,
            [id]: { state: "failed", error: (err instanceof Error ? err.message : String(err)).split("\n")[0]!, at, route },
          }));
        }
      }),
    );
    setChecking(false);
  }, []);

  useEffect(() => {
    void verify(entries);
  }, [entries, verify]);

  return { entries, checks, checking, refresh: () => verify(entries) };
}

export const watchKey = idOf;
