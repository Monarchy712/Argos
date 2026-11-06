/**
 * Describes, in plain language, what changed about a contract's call surface when Argos detects
 * that the code behind a proxy changed — using a model on 0G Private Computer.
 *
 *   node --env-file=.env scripts/explain-change.ts --chain 11155111 --address 0xb8E5… [--write]
 *   node --env-file=.env scripts/explain-change.ts --from 0xImplA --to 0xImplB --chain 11155111
 *
 * WHAT THIS IS, AND WHAT IT REFUSES TO BE. Argos detects that code changed; it has never been able
 * to say what the change *was*. This fills that gap and nothing more. The model is given two
 * selector sets recovered from deployed bytecode and the function signatures the ERC-7730
 * descriptor documents, and asked to describe the difference. It is explicitly instructed not to
 * judge safety, and its output is rendered under a heading that says so. A model cannot know
 * whether an upgrade is malicious, and a confident guess is the exact failure Argos exists to
 * warn about.
 *
 * WHY BYTECODE AND NOT SOURCE. Verified source would mean depending on a block explorer and would
 * fail for unverified contracts — including our own Sepolia demo implementations. `eth_getCode`
 * always works. See packages/core/src/selectors.ts for what that heuristic does and doesn't give.
 *
 * WHERE THE ANSWER GOES (--write). The text goes to Swarm and a `dg_change_note` row on Arkiv
 * records its keccak hash, the model, the 0G request id, the provider and the cost. That is the
 * same split Argos uses for descriptors, so the browser verifies the words it renders instead of
 * trusting a gateway, and reads them keylessly. Without --write nothing is published.
 *
 * Env: ZEROG_API_KEY (required), ZEROG_BASE_URL (optional), MAINNET_RPC_URL / SEPOLIA_RPC_URL,
 *      ARKIV_ACCESS_KEY (optional, read), ARKIV_WRITER_PRIVATE_KEY (only with --write).
 */
import { createPublicClient as createArkivClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { addr, u64 } from "@arkiv-network/sdk/schema";
import { createPublicClient, http, isAddress, isHex, keccak256, stringToBytes, getAddress, type Address } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  BaselineSchema,
  ChangeNoteSchema,
  DeploymentSchema,
  DescriptorSchema,
  EXPIRY,
  LatestChangeSchema,
  TRUSTED_CREATORS,
  describeError,
  diffSelectors,
  sameSurface,
  selectorsFromBytecode,
  withoutErrorSelectors,
  type Selector,
} from "@driftguard/core";

const PUBLIC_GATEWAY = process.env.SWARM_PUBLIC_GATEWAY ?? "https://api.gateway.ethswarm.org";
const OPENCHAIN = "https://api.openchain.xyz/signature-database/v1/lookup";
const DEFAULT_BASE_URL = "https://router-api.0g.ai/v1";
const DEFAULT_MODEL = "gemini-2.5-flash";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const write = args.includes("--write");
const chainId = Number(flag("chain") ?? 11155111);
const model = flag("model") ?? DEFAULT_MODEL;
const log = (msg: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

const apiKey = process.env.ZEROG_API_KEY;
if (!apiKey) throw new Error("set ZEROG_API_KEY in .env (https://pc.0g.ai → dashboard → API keys)");
const baseUrl = (process.env.ZEROG_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");

const RPC: Record<number, { chain: typeof mainnet | typeof sepolia; env: string }> = {
  1: { chain: mainnet, env: "MAINNET_RPC_URL" },
  11155111: { chain: sepolia, env: "SEPOLIA_RPC_URL" },
};
const rpc = RPC[chainId];
if (!rpc) throw new Error(`unsupported chain ${chainId} (1 or 11155111)`);
const chainClient = createPublicClient({ chain: rpc.chain, transport: http(process.env[rpc.env]) });
const arkiv = createArkivClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });

// ---- 1. work out which two implementations to compare -----------------------------------------
let address = flag("address");
let from = flag("from") as Address | undefined;
let to = flag("to") as Address | undefined;
let changeBlock = 0n;

if (!from || !to) {
  if (!address || !isAddress(address)) throw new Error("pass --address <proxy> (or both --from and --to)");
  const proxy = getAddress(address);
  const [baselines, changes] = await Promise.all([
    arkiv.select().from(BaselineSchema).createdBy(TRUSTED_CREATORS.writer).limit(100).fetch(),
    arkiv.select().from(LatestChangeSchema).createdBy(TRUSTED_CREATORS.watcher).limit(100).fetch(),
  ]);
  const same = (r: { chain_id: { value: bigint }; address: { value: string } }) =>
    Number(r.chain_id.value) === chainId && r.address.value.toLowerCase() === proxy.toLowerCase();
  const baseline = baselines.entities.find(same);
  const change = changes.entities.find(same);
  if (!baseline) throw new Error(`no Argos baseline on Arkiv for ${chainId}:${proxy}`);
  if (!change) throw new Error(`no change recorded on Arkiv for ${chainId}:${proxy} — nothing to explain`);
  from = getAddress(change.previous_value.value as Address);
  to = getAddress(change.new_value.value as Address);
  changeBlock = change.change_block.value;
} else {
  from = getAddress(from);
  to = getAddress(to);
  address = address && isAddress(address) ? getAddress(address) : undefined;
}
if (from.toLowerCase() === to.toLowerCase()) throw new Error("from and to are the same implementation; nothing to compare");
log("comparing", { chainId, proxy: address ?? "(none)", from, to, changeBlock: changeBlock.toString() });

// ---- 2. selectors from deployed bytecode ------------------------------------------------------
const [codeFrom, codeTo] = await Promise.all([chainClient.getCode({ address: from }), chainClient.getCode({ address: to })]);
if (!codeFrom || codeFrom === "0x") throw new Error(`${from} has no deployed code on chain ${chainId}`);
if (!codeTo || codeTo === "0x") throw new Error(`${to} has no deployed code on chain ${chainId}`);
const before = withoutErrorSelectors(selectorsFromBytecode(codeFrom));
const after = withoutErrorSelectors(selectorsFromBytecode(codeTo));
const diff = diffSelectors(before, after);
log("selectors", { before: before.length, after: after.length, added: diff.added.length, removed: diff.removed.length, sameSurface: sameSurface(diff) });

// ---- 3. resolve selectors to signatures (keyless, best effort) --------------------------------
async function resolve(selectors: readonly Selector[]): Promise<Record<string, string>> {
  if (selectors.length === 0) return {};
  try {
    const res = await fetch(`${OPENCHAIN}?function=${selectors.join(",")}&filter=true`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return {};
    const body = (await res.json()) as { result?: { function?: Record<string, { name: string }[] | null> } };
    return Object.fromEntries(
      Object.entries(body.result?.function ?? {})
        .map(([sel, hits]) => [sel, hits?.[0]?.name])
        .filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {}; // a signature database being down must not stop the explanation
  }
}
const names = await resolve([...diff.added, ...diff.removed, ...diff.kept]);
const show = (s: Selector) => (names[s] ? `${s} ${names[s]}` : `${s} (unknown signature)`);

// ---- 4. what the descriptor documents ---------------------------------------------------------
/** The ERC-7730 descriptor bound to this proxy, if the mirror has one. Context for the model:
 *  these are the functions a wallet is currently willing to render an intent for. */
let documented: string[] = [];
if (address) {
  try {
    const deps = await arkiv.select().from(DeploymentSchema).createdBy(TRUSTED_CREATORS.writer).limit(100).fetch();
    const dep = deps.entities.find(
      (d) => Number(d.chain_id.value) === chainId && d.address.value.toLowerCase() === address!.toLowerCase(),
    );
    if (dep) {
      const descs = await arkiv.select().from(DescriptorSchema).createdBy(TRUSTED_CREATORS.writer).limit(100).fetch();
      const desc = descs.entities.find((d) => d.descriptor_hash.value === dep.descriptor_hash.value);
      if (desc) documented = [desc.registry_path.value];
    }
  } catch (err) {
    log("descriptor lookup failed (continuing without it)", { error: describeError(err) });
  }
}

// ---- 5. ask 0G --------------------------------------------------------------------------------
const facts = [
  `Chain id: ${chainId}`,
  address ? `Proxy: ${address}` : null,
  `Previous implementation: ${from}`,
  `New implementation: ${to}`,
  documented.length ? `ERC-7730 descriptor bound to this proxy: ${documented.join(", ")}` : "No ERC-7730 descriptor is bound to this proxy.",
  "",
  `Functions only in the PREVIOUS code (${diff.removed.length}): ${diff.removed.map(show).join("; ") || "none"}`,
  `Functions only in the NEW code (${diff.added.length}): ${diff.added.map(show).join("; ") || "none"}`,
  `Present in both (${diff.kept.length}): ${diff.kept.map(show).join("; ") || "none"}`,
]
  .filter((l) => l !== null)
  .join("\n");

const system = [
  "You explain what changed between two versions of a smart contract's code, for a tool called Argos that warns people when the code behind a clear-signing descriptor changes.",
  "You are given 4-byte function selectors recovered from DEPLOYED BYTECODE, not from verified source. That list is a superset of the real external ABI: it can include constants and can miss assembly dispatchers. Never state it as the definitive ABI.",
  "",
  "Write 2 to 4 short sentences of plain English. Rules, all of them hard:",
  "- Describe only what the evidence shows: which callable functions appeared, disappeared, or stayed.",
  "- NEVER say whether the change is safe, unsafe, malicious, benign, suspicious, risky or trustworthy. You cannot know, and claiming to is the exact failure this tool exists to warn about.",
  "- NEVER recommend an action, and never reassure.",
  "- If no functions were added or removed, say that the call surface looks unchanged while the code behind it is different, and that identical selectors do not mean identical behaviour.",
  "- If a descriptor is bound to the proxy, say whether the functions it documents are still present.",
  "- No preamble, no headings, no bullet points, no markdown. Just the sentences.",
].join("\n");

log("asking 0G", { model, baseUrl });
const started = Date.now();
const res = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: facts },
    ],
    max_tokens: 400,
    temperature: 0.2,
    stream: false,
  }),
  signal: AbortSignal.timeout(120_000),
});
const bodyText = await res.text();
if (!res.ok) throw new Error(`0G HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
type Completion = {
  choices?: { message?: { content?: string } }[];
  model?: string;
  x_0g_trace?: { request_id?: string; provider?: string; billing?: { total_cost_usd_micro?: string } };
};
const completion = JSON.parse(bodyText) as Completion;
const summary = (completion.choices?.[0]?.message?.content ?? "").trim();
if (!summary) throw new Error(`0G returned no content: ${bodyText.slice(0, 300)}`);
const trace = completion.x_0g_trace ?? {};
log("0G answered", {
  model: completion.model ?? model,
  requestId: trace.request_id,
  provider: trace.provider,
  costUsdMicro: trace.billing?.total_cost_usd_micro,
  ms: Date.now() - started,
});
console.log(`\n${summary}\n`);

if (!write) {
  log("not published", { hint: "pass --write to put the text on Swarm and a dg_change_note row on Arkiv" });
  process.exitCode = 0;
} else {
  // ---- 6. publish: text on Swarm, facts + hash on Arkiv ---------------------------------------
  const key = process.env.ARKIV_WRITER_PRIVATE_KEY;
  if (!key || !isHex(key)) throw new Error("--write needs ARKIV_WRITER_PRIVATE_KEY in .env");
  if (!address) throw new Error("--write needs --address (the proxy the note is about)");

  const bytes = stringToBytes(summary);
  const summaryHash = keccak256(bytes);
  const up = await fetch(`${PUBLIC_GATEWAY}/bytes`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from(bytes),
    signal: AbortSignal.timeout(60_000),
  });
  if (up.status !== 200 && up.status !== 201) throw new Error(`Swarm upload HTTP ${up.status}: ${(await up.text()).slice(0, 200)}`);
  const swarmRef = String(((await up.json()) as { reference?: string }).reference ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(swarmRef)) throw new Error(`unexpected Swarm reference: ${swarmRef}`);

  const back = await fetch(`${PUBLIC_GATEWAY}/bytes/${swarmRef}`, { signal: AbortSignal.timeout(30_000) });
  const readBack = new Uint8Array(await back.arrayBuffer());
  if (keccak256(readBack) !== summaryHash) throw new Error("Swarm returned different bytes than we uploaded; not writing to Arkiv");
  log("summary on Swarm", { reference: swarmRef, hash: summaryHash, bytes: bytes.length });

  const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });
  const existing = await arkiv.select().from(ChangeNoteSchema).createdBy(TRUSTED_CREATORS.writer).limit(100).fetch();
  const stale = existing.entities.filter(
    (n) => Number(n.chain_id.value) === chainId && n.address.value.toLowerCase() === address!.toLowerCase(),
  );
  const receipt = await wallet.executeBatch({
    creates: [
      {
        schema: ChangeNoteSchema,
        values: {
          chain_id: u64(BigInt(chainId)),
          address: addr(address as Address),
          from_implementation: addr(from),
          to_implementation: addr(to),
          change_block: u64(changeBlock),
          summary_hash: summaryHash as string,
          summary_swarm_ref: swarmRef,
          selectors_added: u64(BigInt(diff.added.length)),
          selectors_removed: u64(BigInt(diff.removed.length)),
          same_surface: sameSurface(diff),
          model: completion.model ?? model,
          zerog_request_id: trace.request_id ?? "",
          zerog_provider: trace.provider ?? "",
          cost_usd_micro: u64(BigInt(trace.billing?.total_cost_usd_micro ?? "0")),
          generated_at: u64(BigInt(Math.floor(Date.now() / 1000))),
        },
        expiration: ExpirationTime.fromSeconds(EXPIRY.longSeconds),
      },
    ],
    // One note per contract: the previous one is removed in the same transaction.
    deletes: stale.map((n) => ({ entityKey: n.$key })),
  });
  log("published", { arkivTx: receipt.txHash, replaced: stale.length, requestId: trace.request_id });
}
