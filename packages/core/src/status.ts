/**
 * The one place that turns evidence into a status (docs/ARCHITECTURE.md §5.4). Pure, so the web
 * app, a Snap or a CLI all show exactly the same thing for the same evidence.
 *
 *   RED          — a trusted source shows the code identity differs from the baseline *now*
 *                  (the watcher's current_state, or a live read).
 *   GREEN        — baseline + fresh, unexpired watcher record that matches, and no live read
 *                  disagreeing. "No change seen as of block N", never "safe".
 *   NOT VERIFIED — anything else, always with a reason.
 *
 * Wording rule: describe what changed, never why. No "malicious", "unsafe", "attack".
 */
import type { Hex } from "viem";

export type Status = "GREEN" | "RED" | "NOT_VERIFIED";

export interface BaselineEvidence {
  codeIdentity: Hex;
  block: bigint;
}

export interface CurrentEvidence {
  codeIdentity: Hex;
  matchesBaseline: boolean;
  everChangedSinceBaseline: boolean;
  checkedBlock: bigint;
  /** unix seconds of the watcher's last slot read */
  checkedAt: number;
  /** unix seconds when the Arkiv entity expires (rows past this are not returned anyway) */
  expiresAt?: number;
}

export interface LatestChangeEvidence {
  field: string;
  changeBlock: bigint;
  txHash: string;
}

export type LiveEvidence =
  | { state: "not-run" }
  | { state: "pending" }
  | { state: "ok"; codeIdentity: Hex; block: bigint }
  | { state: "failed"; error: string };

export interface StatusInput {
  /** unix seconds */
  now: number;
  /** false when Argos has no baseline for this (chain, address) at all */
  monitored: boolean;
  /** false for proxy patterns the watcher can't read (custom slots, getter-only proxies) */
  supported: boolean;
  baseline: BaselineEvidence | null;
  current: CurrentEvidence | null;
  latestChange: LatestChangeEvidence | null;
  live: LiveEvidence;
  /** a watcher record older than this is stale (default 300 s) */
  staleAfterSeconds?: number;
}

export interface StatusResult {
  status: Status;
  /** short, badge-adjacent sentence */
  headline: string;
  /** every reason that contributed, most important first */
  reasons: string[];
  /** the A→B→A line, when the contract matches now but changed since its baseline */
  note?: string;
}

export const STALE_AFTER_SECONDS = 300;

function ago(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

export function computeStatus(input: StatusInput): StatusResult {
  const { now, baseline, current, latestChange, live } = input;
  const staleAfter = input.staleAfterSeconds ?? STALE_AFTER_SECONDS;

  if (!input.monitored) {
    return { status: "NOT_VERIFIED", headline: "Not monitored", reasons: ["Argos has no baseline for this contract."] };
  }
  if (!input.supported) {
    return {
      status: "NOT_VERIFIED",
      headline: "Unsupported proxy pattern",
      reasons: ["This contract's upgrade mechanism can't be read by Argos, so changes can't be verified."],
    };
  }
  if (!baseline) {
    return { status: "NOT_VERIFIED", headline: "No baseline", reasons: ["No trusted baseline record was found."] };
  }

  const changeAt = latestChange ? ` (block ${latestChange.changeBlock})` : "";
  const liveDiffers = live.state === "ok" && live.codeIdentity.toLowerCase() !== baseline.codeIdentity.toLowerCase();
  const watcherDiffers = current !== null && !current.matchesBaseline;

  // ---- RED: any trusted source shows a different code identity now -----------------------
  if (watcherDiffers || liveDiffers) {
    const reasons: string[] = [];
    if (watcherDiffers) {
      reasons.push(`The watcher saw code that differs from the baseline at block ${current!.checkedBlock}${latestChange ? `; latest change: ${latestChange.field}${changeAt}` : ""}.`);
    }
    if (liveDiffers) reasons.push(`A live read at block ${(live as { block: bigint }).block} differs from the baseline.`);
    if (watcherDiffers && live.state === "ok" && !liveDiffers) {
      reasons.push("A live read matches the baseline again, but the watcher has not confirmed it yet.");
    }
    reasons.push("Check whether the clear-signing descriptor still describes the code that runs now.");
    return { status: "RED", headline: "Monitored change detected", reasons };
  }

  const note =
    current?.everChangedSinceBaseline && current.matchesBaseline
      ? `Matches baseline now, but a change was previously detected${changeAt}.`
      : undefined;

  // ---- NOT VERIFIED: missing, expired, stale or unverifiable evidence ----------------------
  const reasons: string[] = [];
  if (!current) reasons.push("No live watcher record: it expired (watcher not running) or was never written.");
  else if (current.expiresAt !== undefined && current.expiresAt <= now) reasons.push("The watcher record has expired.");
  else if (now - current.checkedAt > staleAfter) reasons.push(`Last verification was ${ago(now - current.checkedAt)} (stale).`);
  if (live.state === "failed") reasons.push(`Live read failed: ${live.error}`);
  if (live.state === "pending") reasons.push("Live read in progress.");
  if (reasons.length) return { status: "NOT_VERIFIED", headline: "Not verified", reasons, note };

  // ---- GREEN ---------------------------------------------------------------------------------
  const green = [`Watcher verified at block ${current!.checkedBlock}, ${ago(now - current!.checkedAt)}, no change from baseline.`];
  if (live.state === "ok") green.push(`A live read at block ${live.block} matches the baseline.`);
  green.push("This is no change seen as of that block, not a guarantee about future blocks.");
  return { status: "GREEN", headline: "Verified recently, no change", reasons: green, note };
}
