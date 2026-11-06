/**
 * Fetches the plain-language change description whose hash a `dg_change_note` row publishes.
 *
 * The row on Arkiv carries facts (which implementations, how many selectors moved, which model,
 * which 0G request id) and `summary_hash`; the words themselves are bytes on Swarm. We fetch
 * those bytes over the same transport as everything else (Nym by default) and **render them only
 * if keccak256(bytes) equals the hash on Arkiv** — the same rule as descriptors. A gateway that
 * returns different words gets rejected rather than displayed, because an unverified sentence
 * about what changed is worth less than no sentence at all.
 *
 * There is deliberately no fallback source. A descriptor has one (the registry at a pinned
 * commit); a change note does not exist anywhere else, so if Swarm can't serve it the UI says so.
 */
import { keccak256, toHex, type Hex } from "viem";
import { anonAwareFetch } from "./transport.ts";
import { SWARM_GATEWAY } from "./config.ts";

export type ChangeNoteText =
  | { state: "ok"; text: string }
  | { state: "mismatch"; expected: Hex; got: Hex }
  | { state: "unavailable"; error: string };

const cache = new Map<string, ChangeNoteText>();

/** Fetch and hash-check the summary bytes for one note. Results are cached per (ref, hash). */
export async function fetchChangeNote(swarmRef: string, summaryHash: Hex): Promise<ChangeNoteText> {
  const cacheKey = `${swarmRef}:${summaryHash}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  let result: ChangeNoteText;
  if (!/^[0-9a-f]{64}$/.test(swarmRef)) {
    result = { state: "unavailable", error: "the Arkiv row carries no usable Swarm reference" };
  } else {
    try {
      const res = await anonAwareFetch(`${SWARM_GATEWAY}/bytes/${swarmRef}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`Swarm HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const got = keccak256(toHex(bytes));
      result =
        got === summaryHash
          ? { state: "ok", text: new TextDecoder().decode(bytes) }
          : { state: "mismatch", expected: summaryHash, got };
    } catch (err) {
      result = { state: "unavailable", error: err instanceof Error ? err.message : String(err) };
    }
  }
  // Don't cache a transient network failure; a retry should be able to succeed.
  if (result.state !== "unavailable") cache.set(cacheKey, result);
  return result;
}
