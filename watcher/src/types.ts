import type { Address, Hex } from "viem";
import type { ChangeField, CodeIdentity, ProxyKind } from "@driftguard/core";

export type Detection = "event+slot" | "slot-only";

/** The trust anchor for one monitored contract (dg_baseline). */
export interface Baseline {
  /** Sink-assigned id (Arkiv entity key, or a local id for the file sink). */
  key: string;
  chainId: number;
  address: Address;
  identity: CodeIdentity;
  identityHash: Hex;
  block: bigint;
  baselinedAt: number;
  descriptorHash: Hex | "";
  swarmRef: string;
  reason: string;
  previousKey: string;
}

/** One detected change (dg_latest_change). */
export interface ChangeRecord {
  chainId: number;
  address: Address;
  field: ChangeField;
  previousValue: string;
  newValue: string;
  changeBlock: bigint;
  txHash: Hex | "";
  detectedAt: number;
  detectedBy: "event" | "slot";
}

/** Liveness + current view (dg_current_state). */
export interface CurrentState {
  chainId: number;
  address: Address;
  identity: CodeIdentity;
  identityHash: Hex;
  matchesBaseline: boolean;
  everChangedSinceBaseline: boolean;
  checkedBlock: bigint;
  checkedAt: number;
  lastScannedBlock: bigint;
  detection: Detection;
  baselineKey: string;
}

/** A decoded log that tells us one identity field changed. */
export interface ObservedEvent {
  field: ChangeField;
  /** New value, lowercased; `null` when the event doesn't carry it (DiamondCut). */
  newValue: string | null;
  block: bigint;
  logIndex: number;
  txHash: Hex;
}

/** Per-contract memory kept between cycles (persisted in the cursor file). */
export interface ContractCursor {
  baselineKey: string;
  last: CodeIdentity;
  everChanged: boolean;
  lastWriteAt: number;
}

export function detectionFor(kind: ProxyKind): Detection {
  return kind === "safe" || kind === "none" ? "slot-only" : "event+slot";
}

export function contractId(chainId: number, address: Address): string {
  return `${chainId}:${address.toLowerCase()}`;
}
