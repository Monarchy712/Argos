/**
 * Disaster recovery: reconstructing an expired Arkiv entity from historical Arkiv blocks.
 *
 *   npm run recover -w watcher -- --report
 *   npm run recover -w watcher -- --entity 0x<key> [--recreate] [--from-block N]
 *   npm run recover -w watcher -- --self-test        # prove it on a throwaway entity
 *
 * WHY THIS IS POSSIBLE. An expired entity cannot be queried — `arkiv_query` and
 * `arkiv_getEntity` only see live entities, and no amount of asking differently changes that. But
 * the write that created it is an ordinary transaction on the Arkiv chain, and the engine's own
 * documentation says so explicitly: it emits "one [event] per applied operation, in application
 * order, so an off-chain replica can replay a transaction operation by operation"
 * (node_modules/@arkiv-network/sdk/src/entity/events.ts). So the payload is recoverable from
 * history:
 *
 *   1. find `EntityCreated(entityKey, owner, expiresAt, creationFlags)` in the logs
 *   2. fetch that transaction and decode its `execute((uint8,bytes)[])` calldata
 *   3. the Create operations in the batch line up, in order, with the EntityCreated events in the
 *      receipt — so the nth event identifies the nth create
 *   4. `abi.decode` the Create payload to get the attribute triples
 *      `(bytes32 name, uint8 typeId, bytes value)`
 *   5. replay every later `EntityPatched` for that key, in block/log order, applying its mutations
 *
 * The ABI shapes are the SDK's own (src/entity/operations.ts, src/entity/events.ts); the type ids
 * are its wire constants (src/schema/types.ts). Nothing here is invented, and nothing here
 * pretends an expired entity can be read back through a normal query.
 *
 * WHAT IS RECOVERED AND WHAT IS NOT. Attribute names and values come back exactly. The entity
 * *key* does not: a key is derived from the owner, their nonce and a salt, so a recreated entity
 * necessarily has a new one. That is why `dg_recovery` exists — it records old key → new key plus
 * the block and transaction the payload came from, so provenance survives the gap.
 *
 * A reconstruction is never presented as verified until the recreated row has been read back from
 * Arkiv and its attributes compared with what was recovered.
 */
import { createPublicClient as createArkivClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc, eq } from "@arkiv-network/sdk/query";
import { addr, bool, bytes as bytesValue, dec, i32, key as keyValue, str, u64, u256 } from "@arkiv-network/sdk/schema";
import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  encodeEventTopics,
  getAddress,
  hexToString,
  http,
  isHex,
  keccak256,
  parseAbi,
  parseAbiParameters,
  size,
  stringToBytes,
  toHex,
  type Hex,
  type Log,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARKIV_BLOCK_SECONDS, RecoverySchema, TRUSTED_CREATORS, describeError } from "@driftguard/core";

/* ----------------------------------------------------------------- the engine's own ABIs */

/** src/entity/events.ts — one event per applied operation, in application order. */
const ENTITY_EVENTS = parseAbi([
  "event EntityCreated(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt, uint8 creationFlags)",
  "event EntityPatched(bytes32 indexed entityKey, address indexed owner)",
  "event ExpiryExtended(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt)",
  "event OwnershipTransferred(bytes32 indexed entityKey, address indexed previousOwner, address indexed newOwner)",
  "event EntityDeleted(bytes32 indexed entityKey, address indexed owner)",
]);

/** topic0 of each engine event, for a topics-only log filter. */
const ENTITY_TOPICS = ENTITY_EVENTS.map((ev) => encodeEventTopics({ abi: [ev] })[0]!);

/** src/entity/operations.ts — the one external entry point. */
const EXECUTE_ABI = parseAbi(["function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)"]);

const ATTRIBUTE_TUPLE = "(bytes32 name, uint8 typeId, bytes value)[]";
const CREATE_PARAMS = parseAbiParameters(
  `(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, ${ATTRIBUTE_TUPLE} attributes)`,
);
const PATCH_PARAMS = parseAbiParameters(`(bytes32 entityKey, ${ATTRIBUTE_TUPLE} mutations)`);

/** src/entity/params.ts OperationType. */
const OP_CREATE = 1;
const OP_PATCH = 2;

/** src/schema/types.ts TYPE_IDS and INDEXED_FLAG. `bytes32` (6) is read as `key`. */
const TYPE_BY_ID: Record<number, string> = { 1: "bool", 2: "i32", 3: "u64", 4: "u256", 5: "dec", 6: "key", 7: "bytes", 8: "str", 9: "addr", 10: "key" };
const INDEXED_FLAG = 0x80;
/** typeId 0 with a zero-length value is a tombstone: the mutation that unsets an attribute. */
const TOMBSTONE = 0;

/** The attribute every named schema tags its entities with (src/schema/schema.ts). */
const SCHEMA_ATTRIBUTE = "arkiv.schema";

/* ----------------------------------------------------------------- decoding */

export interface RecoveredAttribute {
  name: string;
  type: string;
  indexed: boolean;
  /** Decoded into the JSON shape the SDK would render, for display and for re-creation. */
  value: string | boolean | bigint;
  /** The raw ABI bytes, so a reader can re-derive the value independently. */
  raw: Hex;
}

/** Decodes one attribute's ABI bytes according to its declared type. */
function decodeValue(type: string, raw: Hex): string | boolean | bigint {
  if (type === "str") return hexToString(raw);
  if (type === "bytes") return raw.toLowerCase();
  if (size(raw) !== 32) throw new Error(`a ${type} value must be 32 bytes, got ${size(raw)}`);
  const word = BigInt(raw);
  switch (type) {
    case "bool":
      if (word !== 0n && word !== 1n) throw new Error("a bool word must hold exactly 0 or 1");
      return word === 1n;
    case "i32":
      return BigInt.asIntN(32, word);
    case "u64":
    case "u256":
      return word;
    case "dec":
      return BigInt.asIntN(256, word);
    case "addr":
      return getAddress(`0x${raw.slice(-40)}`);
    case "key":
      return raw.toLowerCase();
    default:
      throw new Error(`unknown attribute type ${type}`);
  }
}

type AbiAttr = { name: Hex; typeId: number; value: Hex };

function decodeAttributes(attrs: readonly AbiAttr[]): RecoveredAttribute[] {
  const out: RecoveredAttribute[] = [];
  for (const a of attrs) {
    if (a.typeId === TOMBSTONE) continue; // handled by the patch replay, which deletes the name
    const base = a.typeId & ~INDEXED_FLAG;
    const type = TYPE_BY_ID[base];
    if (!type) throw new Error(`unknown wire typeId ${a.typeId}`);
    // Ident32 is left-aligned and null-padded.
    const name = hexToString(a.name).replace(/\0+$/, "");
    out.push({ name, type, indexed: (a.typeId & INDEXED_FLAG) !== 0, value: decodeValue(type, a.value), raw: a.value.toLowerCase() as Hex });
  }
  return out;
}

/** Names a patch tombstoned, which the replay must remove. */
function tombstonedNames(attrs: readonly AbiAttr[]): string[] {
  return attrs.filter((a) => a.typeId === TOMBSTONE).map((a) => hexToString(a.name).replace(/\0+$/, ""));
}

/* ----------------------------------------------------------------- reconstruction */

export interface Reconstruction {
  entityKey: Hex;
  /** The schema name the entity carried, from its `arkiv.schema` attribute. */
  schemaName: string;
  owner: Hex;
  createdBlock: bigint;
  createdTx: Hex;
  /** The expiry the create (or the last extension) set, as a block height. */
  expiresAtBlock: bigint;
  /** Attributes after replaying the create and every later patch, in order. */
  attributes: RecoveredAttribute[];
  /** How many EntityPatched events were replayed. */
  patchesApplied: number;
  /** True when an EntityDeleted was seen: the entity was removed, not expired. */
  deleted: boolean;
  /** keccak256 over the canonical rendering of the attribute set. */
  payloadHash: Hex;
  /** Every operation the engine recorded for this key, for an audit trail. */
  history: { event: string; block: bigint; tx: Hex }[];
}

/** A stable hash over the recovered attribute set, so a reconstruction can be re-checked. */
export function payloadHash(attrs: readonly RecoveredAttribute[]): Hex {
  const canonical = [...attrs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `${a.name}:${a.type}:${a.raw}`)
    .join("\n");
  return keccak256(stringToBytes(canonical));
}

export interface RecoverDeps {
  log: (msg: string, data?: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
}

const arkivPublic = (env: NodeJS.ProcessEnv) =>
  createArkivClient({ chain: rabdi({ accessKey: env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });

/**
 * Finds every engine event for one entity key.
 *
 * Goes through `eth_getLogs` directly rather than viem's `getLogs`, because viem builds its topic
 * filter from `event`/`events` + `args` and silently drops a raw `topics` array — the request
 * goes out as `"topics":[]`, the node answers with every engine event in the range, and the
 * reconstruction then lines an unrelated transaction up against the wrong key. (That is exactly
 * what happened the first time this ran: it picked the earliest EntityCreated in the window.)
 *
 * No `address` filter, so the engine's address comes out of the logs instead of being hard-coded:
 * the SDK does not export ARKIV_ADDRESS, and a stale constant would be one more thing to get
 * silently wrong. The caller re-checks every decoded event's key regardless.
 */
type RawLog = { address: Hex; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex };

async function entityLogs(client: ReturnType<typeof arkivPublic>, entityKey: Hex, fromBlock: bigint, toBlock: bigint, chunk: bigint, log: RecoverDeps["log"]) {
  const found: Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock;
    try {
      // topic0 = any engine event, topic1 = this entity. An array in a topic position is an OR.
      const raw = (await client.request({
        method: "eth_getLogs",
        params: [{ fromBlock: toHex(start), toBlock: toHex(end), topics: [ENTITY_TOPICS, entityKey] }],
      } as never)) as unknown as RawLog[];
      for (const l of raw) {
        found.push({
          address: l.address,
          topics: l.topics,
          data: l.data,
          blockNumber: BigInt(l.blockNumber),
          logIndex: Number(l.logIndex),
          transactionHash: l.transactionHash,
        } as unknown as Log);
      }
    } catch (err) {
      log("log scan chunk failed", { from: start.toString(), to: end.toString(), error: describeError(err) });
    }
  }
  return found;
}

/**
 * Reconstructs one entity from history.
 *
 * `fromBlock` matters: Arkiv keeps a long chain and scanning all of it is slow, so a caller that
 * knows roughly when the entity was written should say so. `--report` derives a sensible window
 * from the entity's schema and the oldest live row of the same kind.
 */
export async function reconstructEntity(
  entityKey: Hex,
  opts: { fromBlock?: bigint; toBlock?: bigint; chunk?: bigint },
  deps: RecoverDeps,
): Promise<Reconstruction> {
  const env = deps.env ?? process.env;
  const client = arkivPublic(env);
  // Arkiv's RPC refuses a range whose toBlock is past the head ("block range extends beyond
  // current head block") rather than clipping it, so clamp here.
  const chainHead = await client.getBlockNumber();
  const head = opts.toBlock !== undefined && opts.toBlock < chainHead ? opts.toBlock : chainHead;
  const from = opts.fromBlock !== undefined && opts.fromBlock > 0n ? opts.fromBlock : 0n;
  const chunk = opts.chunk ?? 10_000n;

  const logs = await entityLogs(client, entityKey, from, head, chunk, deps.log);
  if (logs.length === 0) {
    throw new Error(
      `no engine events found for ${entityKey} between blocks ${from} and ${head}. Either the key is wrong, or the ` +
        `create is outside this window — pass --from-block to widen it.`,
    );
  }

  const decoded = logs
    .map((l) => ({ l, d: tryDecodeEvent(l) }))
    .filter((x): x is { l: Log; d: { eventName: string; args: Record<string, unknown> } } => x.d !== null)
    // Re-check the key after decoding. The node's topic filter is trusted for efficiency, not for
    // correctness: one unfiltered response would otherwise align a stranger's create with our key.
    .filter((x) => String(x.d.args.entityKey).toLowerCase() === entityKey.toLowerCase())
    .sort((a, b) => (a.l.blockNumber === b.l.blockNumber ? Number(a.l.logIndex) - Number(b.l.logIndex) : Number((a.l.blockNumber ?? 0n) - (b.l.blockNumber ?? 0n))));

  const created = decoded.find((x) => x.d.eventName === "EntityCreated");
  if (!created) throw new Error(`found ${decoded.length} event(s) for ${entityKey} but no EntityCreated in this window; widen --from-block`);

  // ---- the create's payload ------------------------------------------------------------------
  const createdTx = created.l.transactionHash as Hex;
  const createdBlock = created.l.blockNumber!;
  const createAttrs = await createPayload(client, createdTx, entityKey);
  let attributes = decodeAttributes(createAttrs);

  // ---- replay every later patch, in order ----------------------------------------------------
  let patchesApplied = 0;
  let deleted = false;
  let expiresAtBlock = BigInt((created.d.args.expiresAt as bigint | number | string) ?? 0);
  const history: Reconstruction["history"] = [];

  for (const x of decoded) {
    history.push({ event: x.d.eventName, block: x.l.blockNumber!, tx: x.l.transactionHash as Hex });
    if (x.d.eventName === "ExpiryExtended") expiresAtBlock = BigInt((x.d.args.expiresAt as bigint | number | string) ?? expiresAtBlock);
    if (x.d.eventName === "EntityDeleted") deleted = true;
    if (x.d.eventName !== "EntityPatched") continue;
    try {
      const mutations = await patchPayload(client, x.l.transactionHash as Hex, entityKey, patchesApplied);
      const removed = new Set(tombstonedNames(mutations));
      const set = decodeAttributes(mutations);
      const byName = new Map(attributes.map((a) => [a.name, a]));
      for (const name of removed) byName.delete(name);
      for (const a of set) byName.set(a.name, a);
      attributes = [...byName.values()];
      patchesApplied++;
    } catch (err) {
      // A patch that cannot be decoded makes the result partial, and saying so is the point.
      deps.log("could not replay a patch", { entityKey, tx: x.l.transactionHash, error: describeError(err) });
      throw new Error(`patch replay failed at ${x.l.transactionHash}: ${describeError(err)}. The reconstruction would be incomplete.`);
    }
  }

  const schemaName = String(attributes.find((a) => a.name === SCHEMA_ATTRIBUTE)?.value ?? "");
  return {
    entityKey,
    schemaName,
    owner: created.d.args.owner as Hex,
    createdBlock,
    createdTx,
    expiresAtBlock,
    attributes,
    patchesApplied,
    deleted,
    payloadHash: payloadHash(attributes),
    history,
  };
}

function tryDecodeEvent(l: Log): { eventName: string; args: Record<string, unknown> } | null {
  for (const ev of ENTITY_EVENTS) {
    try {
      const d = decodeEventLog({ abi: [ev], topics: l.topics, data: l.data });
      return { eventName: d.eventName as string, args: (d.args ?? {}) as Record<string, unknown> };
    } catch {
      /* not this event: try the next signature */
    }
  }
  return null;
}

/** The attribute triples of the Create operation that produced `entityKey`, from the tx calldata. */
async function createPayload(client: ReturnType<typeof arkivPublic>, txHash: Hex, entityKey: Hex): Promise<AbiAttr[]> {
  const tx = await client.getTransaction({ hash: txHash });
  const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data: tx.input });
  const ops = args[0] as readonly { operation: number; operationData: Hex }[];
  const receipt = await client.getTransactionReceipt({ hash: txHash });

  // Creates lead the batch and emit one EntityCreated each, in order. So the index of this key
  // among the receipt's EntityCreated events is the index of its Create among the batch's creates.
  const createdKeys: Hex[] = [];
  for (const l of receipt.logs) {
    const d = tryDecodeEvent(l as Log);
    if (d?.eventName === "EntityCreated") createdKeys.push(String(d.args.entityKey).toLowerCase() as Hex);
  }
  const which = createdKeys.indexOf(entityKey.toLowerCase() as Hex);
  if (which < 0) throw new Error(`${txHash} has no EntityCreated for ${entityKey}`);

  const creates = ops.filter((o) => o.operation === OP_CREATE);
  if (creates.length !== createdKeys.length) {
    throw new Error(`${txHash} carries ${creates.length} create operation(s) but emitted ${createdKeys.length} EntityCreated event(s); cannot align them`);
  }
  const [payload] = decodeAbiParameters(CREATE_PARAMS, creates[which]!.operationData);
  return (payload as { attributes: readonly AbiAttr[] }).attributes as AbiAttr[];
}

/** The mutations of the nth Patch operation for `entityKey` in `txHash`. */
async function patchPayload(client: ReturnType<typeof arkivPublic>, txHash: Hex, entityKey: Hex, _nth: number): Promise<AbiAttr[]> {
  const tx = await client.getTransaction({ hash: txHash });
  const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data: tx.input });
  const ops = args[0] as readonly { operation: number; operationData: Hex }[];
  // A patch names its target in its own payload, so it needs no alignment with events.
  for (const op of ops) {
    if (op.operation !== OP_PATCH) continue;
    const [payload] = decodeAbiParameters(PATCH_PARAMS, op.operationData);
    const p = payload as { entityKey: Hex; mutations: readonly AbiAttr[] };
    if (p.entityKey.toLowerCase() === entityKey.toLowerCase()) return p.mutations as AbiAttr[];
  }
  throw new Error(`${txHash} has no patch operation for ${entityKey}`);
}

/* ----------------------------------------------------------------- re-creation */

/** Turns a recovered attribute back into the SDK value its type calls for. */
function toSdkValue(a: RecoveredAttribute): unknown {
  switch (a.type) {
    case "bool": return a.value as boolean;
    case "i32": return i32(Number(a.value as bigint));
    case "u64": return u64(a.value as bigint);
    case "u256": return u256(a.value as bigint);
    case "dec": return dec(String(a.value));
    case "addr": return addr(a.value as `0x${string}`);
    case "key": return keyValue(a.value as Hex);
    case "bytes": return bytesValue(a.value as Hex);
    case "str": return str(a.value as string);
    default: throw new Error(`cannot re-create a ${a.type} attribute`);
  }
}

export interface RecreateResult {
  newEntityKey: Hex;
  recoveryKey: Hex;
  /** True only after the new row was read back and its payload hash matched. */
  verified: boolean;
  detail: string;
}

/**
 * Recreates a reconstructed entity and records the old → new mapping.
 *
 * The new entity is created through its original schema, so it is indistinguishable from a
 * freshly written row to every reader — which is the point, because readers filter on
 * `$creator` and the schema tag. Provenance lives in the `dg_recovery` row, not in extra
 * attributes on the recreated entity, so the recovered row's shape still matches its schema.
 *
 * `status` on the recovery row starts at "reconstructed" and becomes "verified" only after the
 * new entity has been read back and compared. Nothing calls a recovered record verified before
 * that.
 */
export async function recreateEntity(r: Reconstruction, schema: { name?: string } & Record<string, unknown>, deps: RecoverDeps): Promise<RecreateResult> {
  const env = deps.env ?? process.env;
  const writerKey = env.ARKIV_WRITER_PRIVATE_KEY;
  if (!writerKey || !isHex(writerKey)) throw new Error("set ARKIV_WRITER_PRIVATE_KEY to recreate an entity");
  const account = privateKeyToAccount(writerKey);
  if (account.address !== TRUSTED_CREATORS.writer) {
    throw new Error(`writer key is ${account.address}, expected ${TRUSTED_CREATORS.writer}: a recreated entity written by any other wallet would be ignored by every client`);
  }
  const chain = rabdi({ accessKey: env.ARKIV_ACCESS_KEY ?? "" });
  const wallet = createWalletClient({ chain, transport: http(), account });
  const client = arkivPublic(env);

  // The schema tag is set by the schema itself, so it must not be passed as a value.
  const values = Object.fromEntries(
    r.attributes.filter((a) => a.name !== SCHEMA_ATTRIBUTE).map((a) => [a.name, toSdkValue(a)]),
  );

  const created = await wallet.executeBatch({
    creates: [{ schema: schema as never, values: values as never, expiration: ExpirationTime.max() }],
  });
  const newEntityKey = created.createdEntities[0]! as Hex;

  // ---- verify by reading the new row back ----------------------------------------------------
  let verified = false;
  let detail = "";
  try {
    // arkiv_getEntity takes a key directly, which is exactly the read needed here (and the one
    // that would have returned null for the expired original).
    const back = await client.getEntity(newEntityKey, schema as never);
    const row = (back as { attributes?: Record<string, { value: unknown }> } | null)?.attributes ??
      (back as unknown as Record<string, { value: unknown }> | null);
    if (!row) {
      detail = "The create was accepted but the new entity could not be read back, so the reconstruction is NOT verified.";
    } else {
      const mismatches = r.attributes
        .filter((a) => a.name !== SCHEMA_ATTRIBUTE)
        .filter((a) => {
          const got = row[a.name]?.value;
          return got === undefined || String(got).toLowerCase() !== String(a.value).toLowerCase();
        })
        .map((a) => a.name);
      verified = mismatches.length === 0;
      detail = verified
        ? `All ${r.attributes.length - 1} recovered attributes read back identically.`
        : `Read back, but these attributes differ: ${mismatches.join(", ")}. NOT verified.`;
    }
  } catch (err) {
    detail = `The create was accepted but verification failed: ${describeError(err)}. NOT verified.`;
  }

  // ---- the old → new mapping -----------------------------------------------------------------
  const recovery = await wallet.executeBatch({
    creates: [
      {
        schema: RecoverySchema,
        values: {
          old_entity_key: r.entityKey,
          new_entity_key: newEntityKey,
          entity_schema: r.schemaName || "(unknown)",
          source_block: u64(r.createdBlock),
          source_tx: r.createdTx,
          original_created_block: u64(r.createdBlock),
          payload_hash: r.payloadHash,
          status: verified ? "verified" : "reconstructed",
          attributes: u64(BigInt(r.attributes.length)),
          detail: detail.slice(0, 120),
          recovered_at: u64(BigInt(Math.floor(Date.now() / 1000))),
        },
        expiration: ExpirationTime.max(),
      },
    ],
  });

  deps.log("entity recreated", {
    old: r.entityKey, new: newEntityKey, schema: r.schemaName, verified,
    recovery: recovery.createdEntities[0], arkivTx: created.txHash,
  });
  return { newEntityKey, recoveryKey: recovery.createdEntities[0]! as Hex, verified, detail };
}

/** Recovery rows, newest first, for `--report` and for the UI. */
export async function listRecoveries(env = process.env) {
  const client = arkivPublic(env);
  const page = await client.select().from(RecoverySchema).createdBy(TRUSTED_CREATORS.writer).orderBy(asc("$key")).limit(100).fetch();
  return page.entities.map((r) => ({
    key: r.$key,
    oldEntityKey: r.old_entity_key.value,
    newEntityKey: r.new_entity_key.value,
    entitySchema: r.entity_schema.value,
    sourceBlock: r.source_block.value,
    sourceTx: r.source_tx.value,
    payloadHash: r.payload_hash.value,
    status: r.status.value,
    attributes: Number(r.attributes.value),
    detail: r.detail.value,
    recoveredAt: Number(r.recovered_at.value),
    expiresInDays: (Number(r.$expiresAt - page.blockNumber) * ARKIV_BLOCK_SECONDS) / 86400,
  }));
}

export { ENTITY_EVENTS, EXECUTE_ABI, CREATE_PARAMS, PATCH_PARAMS, decodeAttributes, decodeValue, TYPE_BY_ID, INDEXED_FLAG, SCHEMA_ATTRIBUTE };
export { toHex };
