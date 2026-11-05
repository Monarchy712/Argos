/**
 * Arkiv sink: baselines come from dg_baseline rows created by the trusted writer; current_state
 * and latest_change are written by the watcher wallet. Verified API shape: docs/TEST_REPORT.md
 * (Test 2) — one executeBatch carries creates + patches + extensions, and a patch never moves
 * expiry, so every current_state rewrite pairs a patch with an extension.
 */
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, eq } from "@arkiv-network/sdk/query";
import { addr, u64 } from "@arkiv-network/sdk/schema";
import { getAddress, http, isHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BaselineSchema,
  CurrentStateSchema,
  EXPIRY,
  LatestChangeSchema,
  TRUSTED_CREATORS,
  type CodeIdentity,
  type ProxyKind,
  type ChangeField,
} from "@driftguard/core";
import type { Sink } from "./sink.ts";
import { contractId, type Baseline, type ChangeRecord, type CurrentState } from "./types.ts";

/** Max contracts per executeBatch (each contributes a patch + an extension, or a create). */
const BATCH = 20;

type AnyWallet = ReturnType<typeof createWalletClient>;
type AnyPublic = ReturnType<typeof createPublicClient>;

function identityAttrs(id: CodeIdentity, identityHash: Hex) {
  return {
    proxy_kind: id.proxyKind,
    implementation: addr(id.implementation),
    implementation_codehash: id.implementationCodehash as string,
    admin: addr(id.admin),
    beacon: addr(id.beacon),
    facets_hash: id.facetsHash as string,
    code_identity: identityHash as string,
  };
}

type Cell<T> = { value: T };
function identityFromRow(r: {
  proxy_kind: Cell<string>;
  implementation: Cell<string>;
  implementation_codehash: Cell<string>;
  admin: Cell<string>;
  beacon: Cell<string>;
  facets_hash: Cell<string>;
}): CodeIdentity {
  return {
    proxyKind: r.proxy_kind.value as ProxyKind,
    implementation: getAddress(r.implementation.value),
    implementationCodehash: r.implementation_codehash.value as Hex,
    admin: getAddress(r.admin.value),
    beacon: getAddress(r.beacon.value),
    facetsHash: r.facets_hash.value as Hex,
  };
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export class ArkivSink implements Sink {
  readonly name = "arkiv";
  private readonly pub: AnyPublic;
  private readonly writer: AnyWallet | null;
  private readonly watcher: AnyWallet | null;
  private readonly writerAddress: Address;
  private readonly watcherAddress: Address;
  /** contractId → entity key of our current_state / latest_change row (null = unknown, look up). */
  private stateKeys: Map<string, Hex> | null = null;
  private changeKeys: Map<string, Hex> | null = null;

  constructor(opts: { pub: AnyPublic; writer: AnyWallet | null; watcher: AnyWallet | null; writerAddress: Address; watcherAddress: Address }) {
    this.pub = opts.pub;
    this.writer = opts.writer;
    this.watcher = opts.watcher;
    this.writerAddress = opts.writerAddress;
    this.watcherAddress = opts.watcherAddress;
  }

  /**
   * Keys are optional: the watcher process needs only ARKIV_WATCHER_PRIVATE_KEY (it reads
   * baselines by the writer's public address); `rebaseline` needs ARKIV_WRITER_PRIVATE_KEY.
   * A key whose address differs from the trusted one is refused, so a misconfigured .env can't
   * publish rows that clients would then ignore.
   */
  static fromEnv(env = process.env): ArkivSink {
    const chain = rabdi({ accessKey: env.ARKIV_ACCESS_KEY ?? "" });
    const pub = createPublicClient({ chain, transport: http() });
    const wallet = (keyName: string, expected: Address): AnyWallet | null => {
      const k = env[keyName];
      if (!k) return null;
      if (!isHex(k)) throw new Error(`${keyName} must be 0x-hex`);
      const account = privateKeyToAccount(k);
      if (account.address !== expected) {
        throw new Error(`${keyName} is ${account.address}, but the trusted address is ${expected} (packages/core/src/trust.ts)`);
      }
      return createWalletClient({ chain, transport: http(), account });
    };
    return new ArkivSink({
      pub,
      writer: wallet("ARKIV_WRITER_PRIVATE_KEY", TRUSTED_CREATORS.writer),
      watcher: wallet("ARKIV_WATCHER_PRIVATE_KEY", TRUSTED_CREATORS.watcher),
      writerAddress: TRUSTED_CREATORS.writer,
      watcherAddress: TRUSTED_CREATORS.watcher,
    });
  }

  private need(w: AnyWallet | null, keyName: string): AnyWallet {
    if (!w) throw new Error(`set ${keyName} in .env for this operation`);
    return w;
  }

  async loadBaselines(): Promise<Baseline[]> {
    const out: Baseline[] = [];
    for (let offset = 0; ; ) {
      const page = await this.pub
        .select()
        .from(BaselineSchema)
        .createdBy(this.writerAddress)
        .orderBy(asc("$key"))
        .limit(100)
        .offset(offset)
        .fetch();
      for (const r of page.entities) {
        out.push({
          key: r.$key,
          chainId: Number(r.chain_id.value),
          address: getAddress(r.address.value),
          identity: identityFromRow(r),
          identityHash: r.code_identity.value as Hex,
          block: r.baseline_block.value,
          baselinedAt: Number(r.baselined_at.value),
          descriptorHash: r.descriptor_hash.value as Hex | "",
          swarmRef: r.swarm_ref.value,
          reason: r.rebaseline_reason.value,
          previousKey: r.previous_baseline_key.value,
        });
      }
      const covered = page.entities.length + page.skipped;
      if (covered < 100) break;
      offset += covered;
    }
    return out;
  }

  /** Creates the new baseline and deletes the previous one for the same contract in ONE tx. */
  async writeBaseline(b: Omit<Baseline, "key">): Promise<string> {
    const writer = this.need(this.writer, "ARKIV_WRITER_PRIVATE_KEY");
    const existing = await this.pub
      .select({ $key: true })
      .from(BaselineSchema)
      .where(and(eq("chain_id", u64(BigInt(b.chainId))), eq("address", addr(b.address))))
      .createdBy(this.writerAddress)
      .fetch();
    const previousKey = existing.entities[0]?.$key ?? "";
    const res = await writer.executeBatch({
      creates: [
        {
          schema: BaselineSchema,
          values: {
            chain_id: u64(BigInt(b.chainId)),
            address: addr(b.address),
            ...identityAttrs(b.identity, b.identityHash),
            descriptor_hash: b.descriptorHash,
            swarm_ref: b.swarmRef,
            baseline_block: u64(b.block),
            baselined_at: u64(BigInt(b.baselinedAt)),
            rebaseline_reason: b.reason,
            previous_baseline_key: previousKey,
          },
          expiration: ExpirationTime.max(),
        },
      ],
      deletes: existing.entities.map((e) => ({ entityKey: e.$key })),
    });
    return res.createdEntities[0]!;
  }

  /** Finds our existing rows (by creator) so updates patch them instead of creating duplicates. */
  private async loadKeys(): Promise<void> {
    const load = async (schema: typeof CurrentStateSchema | typeof LatestChangeSchema) => {
      const m = new Map<string, Hex>();
      for (let offset = 0; ; ) {
        const page = await this.pub
          .select({ $key: true, chain_id: true, address: true })
          .from(schema)
          .createdBy(this.watcherAddress)
          .orderBy(asc("$key"))
          .limit(100)
          .offset(offset)
          .fetch();
        for (const r of page.entities) m.set(contractId(Number(r.chain_id.value), getAddress(r.address.value)), r.$key);
        const covered = page.entities.length + page.skipped;
        if (covered < 100) break;
        offset += covered;
      }
      return m;
    };
    this.stateKeys = await load(CurrentStateSchema);
    this.changeKeys = await load(LatestChangeSchema);
  }

  /**
   * Writes one cycle's current_state rows and latest_change rows. Both rows of a contract go in
   * the SAME executeBatch, so a reader never sees a new latest_change next to an old
   * current_state (found in testing: two separate txs ~6 s apart showed RED briefly after a
   * revert). Contracts are chunked BATCH per transaction.
   */
  async writeCycle(states: CurrentState[], changes: ChangeRecord[]): Promise<void> {
    const watcher = this.need(this.watcher, "ARKIV_WATCHER_PRIVATE_KEY");
    if (!this.stateKeys || !this.changeKeys) await this.loadKeys();
    const stateValues = (r: CurrentState) => ({
      chain_id: u64(BigInt(r.chainId)),
      address: addr(r.address),
      ...identityAttrs(r.identity, r.identityHash),
      matches_baseline: r.matchesBaseline,
      ever_changed_since_baseline: r.everChangedSinceBaseline,
      checked_block: u64(r.checkedBlock),
      checked_at: u64(BigInt(r.checkedAt)),
      last_scanned_block: u64(r.lastScannedBlock),
      detection: r.detection,
      baseline_key: r.baselineKey,
    });
    const changeValues = (r: ChangeRecord) => ({
      chain_id: u64(BigInt(r.chainId)),
      address: addr(r.address),
      field: r.field as ChangeField as string,
      previous_value: r.previousValue,
      new_value: r.newValue,
      change_block: u64(r.changeBlock),
      tx_hash: r.txHash,
      detected_at: u64(BigInt(r.detectedAt > 1e12 ? Math.floor(r.detectedAt / 1000) : r.detectedAt)),
      detected_by: r.detectedBy,
    });
    const shortLived = ExpirationTime.fromSeconds(EXPIRY.currentStateSeconds);

    // Group by contract so a contract's two rows always share a transaction.
    const ids = [...new Set([...states, ...changes].map((r) => contractId(r.chainId, r.address)))];
    const stateById = new Map(states.map((r) => [contractId(r.chainId, r.address), r]));
    const changeById = new Map(changes.map((r) => [contractId(r.chainId, r.address), r]));

    for (const group of chunks(ids, BATCH)) {
      const send = async () => {
        const creates = [];
        const createdFor: { kind: "state" | "change"; id: string }[] = [];
        const patches = [];
        const extensions = [];
        for (const id of group) {
          const st = stateById.get(id);
          if (st) {
            const key = this.stateKeys!.get(id);
            if (key) {
              patches.push({ schema: CurrentStateSchema, entityKey: key, set: stateValues(st) });
              extensions.push({ entityKey: key, expiration: shortLived });
            } else {
              creates.push({ schema: CurrentStateSchema, values: stateValues(st), expiration: shortLived });
              createdFor.push({ kind: "state", id });
            }
          }
          const ch = changeById.get(id);
          if (ch) {
            const key = this.changeKeys!.get(id);
            if (key) patches.push({ schema: LatestChangeSchema, entityKey: key, set: changeValues(ch) });
            else {
              creates.push({ schema: LatestChangeSchema, values: changeValues(ch), expiration: ExpirationTime.max() });
              createdFor.push({ kind: "change", id });
            }
          }
        }
        const res = await watcher.executeBatch({ creates, patches, extensions });
        createdFor.forEach((c, i) => (c.kind === "state" ? this.stateKeys! : this.changeKeys!).set(c.id, res.createdEntities[i]!));
      };
      try {
        await send();
      } catch {
        // Most likely a current_state row expired (dead watcher, long pause) between lookups: the
        // patch of a gone entity fails the whole batch. Re-read which rows exist and retry once.
        await this.loadKeys();
        await send();
      }
    }
  }
}
