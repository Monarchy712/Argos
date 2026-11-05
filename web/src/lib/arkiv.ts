/**
 * The app's only Arkiv access: one bulk read per trusted creator, the same rows for every visitor
 * whatever contract they care about, filtered client-side. Arkiv learns "someone opened
 * DriftGuard", not which contract. Keyless (the browser holds no key), and therefore direct: it is
 * the one disclosed exclusion from Anon-RPC (Arkiv's RPC didn't answer through the Nym exit).
 */
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc } from "@arkiv-network/sdk/query";
import { BaselineSchema, CurrentStateSchema, LatestChangeSchema, TRUSTED_CREATORS } from "@driftguard/core";
import { http, type Address, type Hex } from "viem";
import { ARKIV_BLOCK_SECONDS } from "./config.ts";

export interface BaselineRow {
  key: Hex;
  chainId: number;
  address: Address;
  proxyKind: string;
  implementation: Address;
  codeIdentity: Hex;
  descriptorHash: string;
  swarmRef: string;
  block: bigint;
  baselinedAt: number;
  reason: string;
}
export interface CurrentRow {
  key: Hex;
  chainId: number;
  address: Address;
  implementation: Address;
  codeIdentity: Hex;
  matchesBaseline: boolean;
  everChanged: boolean;
  checkedBlock: bigint;
  checkedAt: number;
  detection: string;
  /** unix seconds, estimated from $expiresAt (a block number) */
  expiresAt: number;
}
export interface ChangeRow {
  key: Hex;
  chainId: number;
  address: Address;
  field: string;
  previousValue: string;
  newValue: string;
  changeBlock: bigint;
  txHash: string;
  detectedAt: number;
  detectedBy: string;
}
export interface ArkivSnapshot {
  baselines: BaselineRow[];
  current: CurrentRow[];
  changes: ChangeRow[];
  arkivBlock: bigint;
  readAt: number;
  ms: number;
}

const client = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http(undefined, { retryCount: 0, timeout: 20_000 }) });

export class ArkivRateLimitedError extends Error {}

function rateLimited(err: unknown): boolean {
  for (let c = err as { status?: number; cause?: unknown } | undefined; c; c = c.cause as typeof c) {
    if (c.status === 429) return true;
  }
  return false;
}

export const idOf = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

export async function readArkiv(): Promise<ArkivSnapshot> {
  const t0 = performance.now();
  try {
    const [b, c, l] = await Promise.all([
      client.select().from(BaselineSchema).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(100).fetch(),
      client.select().from(CurrentStateSchema).createdBy(TRUSTED_CREATORS.watcher).orderBy(asc("$key")).limit(100).fetch(),
      client.select().from(LatestChangeSchema).createdBy(TRUSTED_CREATORS.watcher).orderBy(asc("$key")).limit(100).fetch(),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const arkivBlock = b.blockNumber;
    return {
      baselines: b.entities.map((r) => ({
        key: r.$key,
        chainId: Number(r.chain_id.value),
        address: r.address.value as Address,
        proxyKind: r.proxy_kind.value,
        implementation: r.implementation.value as Address,
        codeIdentity: r.code_identity.value as Hex,
        descriptorHash: r.descriptor_hash.value,
        swarmRef: r.swarm_ref.value,
        block: r.baseline_block.value,
        baselinedAt: Number(r.baselined_at.value),
        reason: r.rebaseline_reason.value,
      })),
      current: c.entities.map((r) => ({
        key: r.$key,
        chainId: Number(r.chain_id.value),
        address: r.address.value as Address,
        implementation: r.implementation.value as Address,
        codeIdentity: r.code_identity.value as Hex,
        matchesBaseline: r.matches_baseline.value,
        everChanged: r.ever_changed_since_baseline.value,
        checkedBlock: r.checked_block.value,
        checkedAt: Number(r.checked_at.value),
        detection: r.detection.value,
        expiresAt: now + Number(r.$expiresAt - c.blockNumber) * ARKIV_BLOCK_SECONDS,
      })),
      changes: l.entities.map((r) => ({
        key: r.$key,
        chainId: Number(r.chain_id.value),
        address: r.address.value as Address,
        field: r.field.value,
        previousValue: r.previous_value.value,
        newValue: r.new_value.value,
        changeBlock: r.change_block.value,
        txHash: r.tx_hash.value,
        detectedAt: Number(r.detected_at.value),
        detectedBy: r.detected_by.value,
      })),
      arkivBlock,
      readAt: Date.now(),
      ms: Math.round(performance.now() - t0),
    };
  } catch (err) {
    if (rateLimited(err)) throw new ArkivRateLimitedError("Arkiv rate-limited this browser's keyless reads; retrying later.");
    throw err;
  }
}
