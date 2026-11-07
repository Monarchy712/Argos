/**
 * Turns a core {@link Inspection} (or the failure to obtain one) into the one outcome the UI shows.
 *
 * The distinction this module exists to preserve: a failed read and a successfully inspected
 * ordinary contract are different answers. Only `not-a-proxy` is a claim about the contract;
 * `rpc-error` and `not-verified` are claims about Argos. A user who pastes a real proxy and gets
 * "this is not a proxy" because a node timed out has been told something false, which is the
 * failure Argos exists to warn about in other people's software.
 */
import { InspectionError, type Architecture, type Inspection } from "@driftguard/core";
import { isAddress } from "viem";

export type OutcomeId =
  | "proxy-detected"
  | "immutable-proxy"
  | "not-a-proxy"
  | "unsupported-proxy"
  | "not-verified"
  | "rpc-error"
  | "invalid-address"
  | "no-code"
  | "delegated-eoa";

export interface Outcome {
  id: OutcomeId;
  /** Short, upper-case, badge-sized. */
  label: string;
  tone: "ok" | "bad" | "warn" | "info" | "neutral";
  /** True only when Argos can baseline and monitor this address. */
  monitorable: boolean;
  /** True when the outcome says something about Argos rather than about the contract. */
  inconclusive: boolean;
  /** One sentence; `Inspection.reason` when the core supplied one. */
  detail: string;
}

const ARCHITECTURE_LABEL: Record<Architecture, string> = {
  eip1967: "EIP-1967 proxy (transparent or UUPS)",
  zeppelinos: "pre-EIP-1967 OpenZeppelin proxy",
  beacon: "EIP-1967 beacon proxy",
  diamond: "EIP-2535 diamond",
  safe: "Safe proxy",
  eip1167: "EIP-1167 minimal proxy",
  "unsupported-proxy": "proxy Argos cannot read",
  none: "not a proxy",
  "delegated-eoa": "EIP-7702 delegated account",
  "no-code": "nothing deployed",
};

/** How Argos describes each architecture it detects, for the inspection panel. */
export const architectureLabel = (a: Architecture) => ARCHITECTURE_LABEL[a];

export function outcomeOf(ins: Inspection): Outcome {
  switch (ins.architecture) {
    case "eip1967":
    case "zeppelinos":
    case "beacon":
    case "diamond":
    case "safe":
      return {
        id: "proxy-detected", label: "PROXY DETECTED", tone: "ok", monitorable: true, inconclusive: false,
        detail: `Argos read this address's ${ARCHITECTURE_LABEL[ins.architecture]} and can monitor which code runs behind it.`,
      };
    case "eip1167":
      return {
        id: "immutable-proxy", label: "IMMUTABLE PROXY", tone: "info", monitorable: true, inconclusive: false,
        detail: ins.reason,
      };
    case "unsupported-proxy":
      return {
        id: "unsupported-proxy", label: "UNSUPPORTED PROXY", tone: "warn", monitorable: false, inconclusive: false,
        detail: ins.reason,
      };
    case "none":
      return {
        id: "not-a-proxy", label: "NOT A PROXY", tone: "neutral", monitorable: true, inconclusive: false,
        detail: ins.reason,
      };
    case "delegated-eoa":
      return {
        id: "delegated-eoa", label: "DELEGATED ACCOUNT", tone: "warn", monitorable: false, inconclusive: false,
        detail: ins.reason,
      };
    case "no-code":
      return {
        id: "no-code", label: "NO CODE", tone: "warn", monitorable: false, inconclusive: false,
        detail: ins.reason,
      };
  }
}

/**
 * An inspection that did not complete. `rpc-error` when a probe failed outright, `not-verified`
 * for anything else — never a classification.
 */
export function failureOutcome(err: unknown): Outcome {
  if (err instanceof InspectionError) {
    return {
      id: "rpc-error", label: "RPC ERROR", tone: "bad", monitorable: false, inconclusive: true,
      detail: `Argos could not complete the ${err.probe} probe, so it has no verdict on this address. This says nothing about whether the address is a proxy — try again, or switch transport. (${err.message})`,
    };
  }
  return {
    id: "not-verified", label: "NOT VERIFIED", tone: "warn", monitorable: false, inconclusive: true,
    detail: `The inspection did not complete, so Argos has no verdict on this address: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
  };
}

export const invalidAddressOutcome: Outcome = {
  id: "invalid-address", label: "INVALID ADDRESS", tone: "bad", monitorable: false, inconclusive: true,
  detail: "That is not a 20-byte hex address.",
};

/** Checks the address shape before any network call, so a typo never reads as an RPC failure. */
export const addressOutcome = (value: string): Outcome | null => (isAddress(value.trim()) ? null : invalidAddressOutcome);
