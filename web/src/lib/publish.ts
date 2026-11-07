/**
 * The browser's side of baseline publication.
 *
 * The browser holds no key and never will: a `dg_baseline` row is signed by the Argos writer
 * wallet, which every client trusts, so the write happens on the server (watcher/src/server.ts,
 * watcher/src/publish.ts). This module posts the request and maps the answer onto states that each
 * say something different — because "we saved your request locally", "the server refused it" and
 * "the row is on Arkiv and we read it back" are three different situations and the old UI showed
 * all of them as "Awaiting baseline publication".
 *
 * The request carries only the network and the address. Every fact in the published row is read
 * by the server from its own RPC, so nothing here can talk Argos into baselining code that was
 * never deployed.
 */
import type { CodeIdentity } from "@driftguard/core";

/** Where the publisher lives. Unset in a build with no server, which is an honest blocked state. */
export const PUBLISHER_URL = ((import.meta.env.VITE_ARGOS_API_URL as string | undefined) ?? "").replace(/\/$/, "");
/**
 * Publish token for this deployment. Present in the bundle, so it is **not** a user secret — it
 * gates casual use of a write endpoint, nothing more. The thing that must never reach the browser
 * is ARKIV_WRITER_PRIVATE_KEY, and it does not: the server signs, the browser only asks.
 */
const PUBLISH_TOKEN = (import.meta.env.VITE_ARGOS_PUBLISH_TOKEN as string | undefined) ?? "";

export const publisherConfigured = () => PUBLISHER_URL.length > 0;

export type PublishState =
  /** No publisher is configured in this build. Nothing was sent and nothing is pending. */
  | { state: "no-publisher" }
  /** The request is in flight. */
  | { state: "publishing" }
  /** The row is on Arkiv and the server read it back. This, and only this, means monitored. */
  | { state: "published"; entityKey: string; identityHash: string; block: string; architecture: string; identity?: CodeIdentity }
  /** A baseline already existed. The contract is monitored; this request changed nothing. */
  | { state: "already-monitored"; entityKey: string; identityHash: string; block: string }
  /** The server will not publish this, and said why. Retrying unchanged will not help. */
  | { state: "rejected"; code: string; message: string }
  /** The publisher is disabled or misconfigured on the server. An operator has to act. */
  | { state: "blocked"; code: string; message: string }
  /** The write may or may not have landed. Never shown as monitored. */
  | { state: "unverified"; message: string; entityKey?: string }
  /** The request did not complete. Retrying may help. */
  | { state: "failed"; message: string };

export interface PublishInput {
  chainId: number;
  address: string;
  reason?: string;
  rebaseline?: boolean;
}

/** One-line summary for a badge. Kept beside the states so wording cannot drift between screens. */
export function publishHeadline(s: PublishState): { label: string; tone: "ok" | "bad" | "warn" | "info" | "neutral" } {
  switch (s.state) {
    case "no-publisher": return { label: "Publication unavailable", tone: "warn" };
    case "publishing": return { label: "Publishing to Arkiv…", tone: "info" };
    case "published": return { label: "Baseline published and verified", tone: "ok" };
    case "already-monitored": return { label: "Already monitored", tone: "ok" };
    case "rejected": return { label: "Publication refused", tone: "bad" };
    case "blocked": return { label: "Publisher not configured", tone: "warn" };
    case "unverified": return { label: "Publication not confirmed", tone: "warn" };
    case "failed": return { label: "Publication failed", tone: "bad" };
  }
}

export async function publishBaseline(input: PublishInput): Promise<PublishState> {
  if (!publisherConfigured()) return { state: "no-publisher" };

  let res: Response;
  try {
    res = await fetch(`${PUBLISHER_URL}/api/baseline`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(PUBLISH_TOKEN ? { authorization: `Bearer ${PUBLISH_TOKEN}` } : {}),
      },
      body: JSON.stringify({ chainId: input.chainId, address: input.address, reason: input.reason, rebaseline: input.rebaseline === true }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    // The request never got an answer, so whether it was applied is genuinely unknown. Report it
    // as failed rather than pending: a spinner that never resolves is the thing being fixed here.
    return { state: "failed", message: `Could not reach the Argos publisher: ${err instanceof Error ? err.message : String(err)}` };
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { state: "failed", message: `The publisher answered HTTP ${res.status} with a body this app could not read.` };
  }

  const state = String(body.state ?? "");
  const message = String(body.message ?? `HTTP ${res.status}`);
  switch (state) {
    case "published":
      return {
        state: "published",
        entityKey: String(body.entityKey),
        identityHash: String(body.identityHash),
        block: String(body.block),
        architecture: String(body.architecture ?? ""),
        identity: body.identity as CodeIdentity | undefined,
      };
    case "already-monitored":
      return { state: "already-monitored", entityKey: String(body.entityKey), identityHash: String(body.identityHash), block: String(body.block) };
    case "rejected":
      return { state: "rejected", code: String(body.code ?? "rejected"), message };
    case "blocked":
      return { state: "blocked", code: String(body.code ?? "blocked"), message };
    case "unverified":
      return { state: "unverified", message, entityKey: body.entityKey ? String(body.entityKey) : undefined };
    default:
      return { state: "failed", message };
  }
}

/** Whether the publisher is reachable and able to sign, for a pre-flight note in the UI. */
export async function publisherHealth(): Promise<{ reachable: boolean; canPublish: boolean; detail: string }> {
  if (!publisherConfigured()) {
    return { reachable: false, canPublish: false, detail: "This build has no VITE_ARGOS_API_URL, so it cannot ask anyone to publish a baseline." };
  }
  try {
    const res = await fetch(`${PUBLISHER_URL}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { reachable: false, canPublish: false, detail: `The publisher answered HTTP ${res.status}.` };
    const h = (await res.json()) as { publisher?: string; writerKey?: string };
    const canPublish = h.publisher === "configured" && h.writerKey === "configured";
    return {
      reachable: true,
      canPublish,
      detail: canPublish
        ? "The Argos publisher is reachable and able to sign a dg_baseline row."
        : `The publisher is reachable but not able to publish (publisher: ${h.publisher ?? "unknown"}, writer key: ${h.writerKey ?? "unknown"}).`,
    };
  } catch (err) {
    return { reachable: false, canPublish: false, detail: `The publisher could not be reached: ${err instanceof Error ? err.message : String(err)}` };
  }
}
