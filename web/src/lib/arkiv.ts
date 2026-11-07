/**
 * The app's only Arkiv access: one bulk read per trusted creator, the same rows for every visitor
 * whatever contract they care about, filtered client-side. Arkiv learns "someone opened
 * Argos", not which contract. Keyless (the browser holds no key), and therefore direct: it is
 * the one disclosed exclusion from Anon-RPC (Arkiv's RPC didn't answer through the Nym exit).
 */
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc } from "@arkiv-network/sdk/query";
import { BaselineSchema, ChangeNoteSchema, CurrentStateSchema, LatestChangeSchema, TRUSTED_CREATORS } from "@driftguard/core";
import { http, type Address, type Hex } from "viem";
import { ARKIV_BLOCK_SECONDS } from "./config.ts";
import { PAGE_SIZE, pageAll } from "./paging.ts";

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
/**
 * A model's plain-language description of what changed between two implementations, produced on
 * 0G Private Computer by `scripts/explain-change.ts`. The text is NOT here: it lives on Swarm and
 * `summaryHash` is keccak256 of those bytes, so the app verifies the words before rendering them
 * (lib/changeNote.ts), exactly as it verifies a descriptor.
 */
export interface ChangeNoteRow {
  key: Hex;
  chainId: number;
  address: Address;
  fromImplementation: Address;
  toImplementation: Address;
  changeBlock: bigint;
  summaryHash: Hex;
  summarySwarmRef: string;
  selectorsAdded: number;
  selectorsRemoved: number;
  sameSurface: boolean;
  model: string;
  requestId: string;
  provider: string;
  costUsdMicro: number;
  generatedAt: number;
}
export interface ArkivSnapshot {
  baselines: BaselineRow[];
  current: CurrentRow[];
  changes: ChangeRow[];
  changeNotes: ChangeNoteRow[];
  arkivBlock: bigint;
  readAt: number;
  ms: number;
}

/**
 * Optional, and empty by default: the app works keyless, which is why it can be served as a
 * static bundle with no backend. The public endpoint is "heavily rate limited" in Arkiv's own
 * words, and this read is four queries that each expand per entity, so a busy deployment does hit
 * it — when it does, every screen says so rather than rendering an empty portfolio.
 *
 * Setting this puts the key in the published bundle, where anyone can read it and spend the
 * quota. It is a read/rate-limit token, not a signing key — the Arkiv keys that can *write*
 * (ARKIV_WRITER_PRIVATE_KEY, ARKIV_WATCHER_PRIVATE_KEY) stay on the server and are never
 * referenced here. Supplying it is an operator's trade of quota-anonymity for throughput.
 */
const ACCESS_KEY = (import.meta.env.VITE_ARKIV_ACCESS_KEY as string | undefined) ?? "";

const client = createPublicClient({ chain: rabdi({ accessKey: ACCESS_KEY }), transport: http(undefined, { retryCount: 0, timeout: 20_000 }) });

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
    // Each page is its own request, so there is no single block the whole snapshot is atomic at.
    // Two different blocks are captured from the *first* page of the query that needs them:
    //   baselineBlock  what the UI displays as "read at Arkiv block N"
    //   currentBlock   the reference `$expiresAt` is measured against for current_state rows,
    //                  which must come from that same query or the arithmetic is comparing a
    //                  block height to an unrelated one.
    let baselineBlock = 0n;
    let currentBlock = 0n;
    /** Captures `blockNumber` off page 0 and otherwise passes the page straight through. */
    const onFirstPage = <P extends { blockNumber: bigint }>(o: number, set: (b: bigint) => void) =>
      (p: P) => { if (o === 0) set(p.blockNumber); return p; };

    const [bRows, cRows, lRows, nRows] = await Promise.all([
      pageAll((o) =>
        client.select().from(BaselineSchema).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(PAGE_SIZE).offset(o).fetch()
          .then(onFirstPage(o, (v) => { baselineBlock = v; }))),
      pageAll((o) =>
        client.select().from(CurrentStateSchema).createdBy(TRUSTED_CREATORS.watcher).orderBy(asc("$key")).limit(PAGE_SIZE).offset(o).fetch()
          .then(onFirstPage(o, (v) => { currentBlock = v; }))),
      pageAll((o) => client.select().from(LatestChangeSchema).createdBy(TRUSTED_CREATORS.watcher).orderBy(asc("$key")).limit(PAGE_SIZE).offset(o).fetch()),
      pageAll((o) => client.select().from(ChangeNoteSchema).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(PAGE_SIZE).offset(o).fetch()),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const arkivBlock = baselineBlock;
    const b = { entities: bRows }, c = { entities: cRows }, l = { entities: lRows }, n = { entities: nRows };
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
        expiresAt: now + Number(r.$expiresAt - currentBlock) * ARKIV_BLOCK_SECONDS,
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
      changeNotes: n.entities.map((r) => ({
        key: r.$key,
        chainId: Number(r.chain_id.value),
        address: r.address.value as Address,
        fromImplementation: r.from_implementation.value as Address,
        toImplementation: r.to_implementation.value as Address,
        changeBlock: r.change_block.value,
        summaryHash: r.summary_hash.value as Hex,
        summarySwarmRef: r.summary_swarm_ref.value,
        selectorsAdded: Number(r.selectors_added.value),
        selectorsRemoved: Number(r.selectors_removed.value),
        sameSurface: r.same_surface.value,
        model: r.model.value,
        requestId: r.zerog_request_id.value,
        provider: r.zerog_provider.value,
        costUsdMicro: Number(r.cost_usd_micro.value),
        generatedAt: Number(r.generated_at.value),
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
