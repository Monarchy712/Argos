/**
 * Generating the plain-language change note when the watcher detects a new implementation.
 *
 * WHAT CHANGED AND WHY. The logic here was only ever reachable by hand —
 * `node scripts/explain-change.ts --address 0x… --write`. So a change detected at 03:00 had no
 * explanation until somebody remembered to run a script, and the guard demo proxy
 * (0x3c93…D669) sat with a `dg_latest_change` at block 12078315 and no `dg_change_note` at all.
 * The watcher now calls this itself, once per change, from `main.ts` — after the change has
 * already been written to Arkiv and the cursor saved, so nothing in here can stop or delay
 * detection. The script remains, for backfilling and for explaining an arbitrary pair of
 * implementations.
 *
 * WHAT IT IS NOT. The model is given two selector sets recovered from deployed bytecode and asked
 * to describe the difference. It is instructed not to judge safety, and the row it produces
 * carries no verdict — only what changed about the call surface, which model said so, and the 0G
 * request id, so the claim is attributable and re-checkable. Argos does not decide whether a
 * change is safe, and neither does the model.
 *
 * WHERE THE ANSWER GOES. The text goes to Swarm; a `dg_change_note` row records keccak256 of
 * those bytes. The browser re-hashes what the gateway serves before rendering a word of it
 * (web/src/lib/changeNote.ts), so a gateway cannot substitute different words.
 *
 * Env: ZEROG_API_KEY (required, server-side only), ZEROG_BASE_URL, ZEROG_MODEL,
 *      ARKIV_WRITER_PRIVATE_KEY (to publish), SWARM_PUBLIC_GATEWAY.
 */
import { createPublicClient as createArkivClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, eq } from "@arkiv-network/sdk/query";
import { addr, u64 } from "@arkiv-network/sdk/schema";
import { getAddress, http, isHex, keccak256, stringToBytes, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ChangeNoteSchema,
  EXPIRY,
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
/** 0G can take a while on a cold provider; past this the attempt is abandoned, not retried forever. */
const ZEROG_TIMEOUT_MS = 120_000;
const ATTEMPTS = 2;

export interface ChangeToExplain {
  chainId: number;
  address: Address;
  from: Address;
  to: Address;
  changeBlock: bigint;
}

export type ExplainResult =
  | { state: "published"; requestId: string; model: string; swarmRef: string; summaryHash: Hex; entityKey: string; costUsdMicro: number }
  /** A note for exactly this change already exists. Not an error — the point of asking first. */
  | { state: "already-explained"; entityKey: string }
  /** Nothing to explain, or nothing Argos can explain. */
  | { state: "skipped"; reason: string }
  | { state: "failed"; stage: "bytecode" | "zerog" | "swarm" | "arkiv"; message: string };

export interface ExplainDeps {
  clientFor: (chainId: number) => PublicClient;
  log: (msg: string, data?: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
}

/** Whether this process is configured to generate explanations at all. */
export const explainConfigured = (env = process.env) => Boolean(env.ZEROG_API_KEY && env.ARKIV_WRITER_PRIVATE_KEY);

const arkivFor = (env: NodeJS.ProcessEnv) =>
  createArkivClient({ chain: rabdi({ accessKey: env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });

/** Best-effort selector → signature names. A signature database being down must not stop the note. */
async function resolveNames(selectors: readonly Selector[]): Promise<Record<string, string>> {
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
    return {};
  }
}

const SYSTEM_PROMPT = [
  "You explain what changed between two versions of a smart contract's code, for a tool called Argos that warns people when the code behind a clear-signing descriptor changes.",
  "You are given 4-byte function selectors recovered from DEPLOYED BYTECODE, not from verified source. That list is a superset of the real external ABI: it can include constants and can miss assembly dispatchers. Never state it as the definitive ABI.",
  "",
  "Write 2 to 4 short sentences of plain English. Rules, all of them hard:",
  "- Describe only what the evidence shows: which callable functions appeared, disappeared, or stayed.",
  "- NEVER say whether the change is safe, unsafe, malicious, benign, suspicious, risky or trustworthy. You cannot know, and claiming to is the exact failure this tool exists to warn about.",
  "- NEVER recommend an action, and never reassure.",
  "- If no functions were added or removed, say that the call surface looks unchanged while the code behind it is different, and that identical selectors do not mean identical behaviour.",
  "- No preamble, no headings, no bullet points, no markdown. Just the sentences.",
].join("\n");

interface Completion {
  choices?: { message?: { content?: string } }[];
  model?: string;
  x_0g_trace?: { request_id?: string; provider?: string; billing?: { total_cost_usd_micro?: string } };
}

/**
 * Asks 0G, retrying once on a transport failure or a 5xx. A 4xx is not retried: a bad key or a
 * rejected model will answer the same way the second time.
 */
async function ask0G(facts: string, env: NodeJS.ProcessEnv, log: ExplainDeps["log"]): Promise<{ summary: string; completion: Completion }> {
  const baseUrl = (env.ZEROG_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = env.ZEROG_MODEL || DEFAULT_MODEL;
  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.ZEROG_API_KEY}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: facts },
          ],
          max_tokens: 400,
          temperature: 0.2,
          stream: false,
        }),
        signal: AbortSignal.timeout(ZEROG_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) {
        // Never log the body verbatim at 401/403: it can echo request headers on some gateways.
        const detail = res.status === 401 || res.status === 403 ? "(body withheld)" : text.slice(0, 200);
        if (res.status < 500 && res.status !== 429) throw new Error(`0G HTTP ${res.status} ${detail}`);
        lastError = `0G HTTP ${res.status} ${detail}`;
        throw Object.assign(new Error(lastError), { retryable: true });
      }
      const completion = JSON.parse(text) as Completion;
      const summary = (completion.choices?.[0]?.message?.content ?? "").trim();
      if (!summary) throw Object.assign(new Error("0G returned no content"), { retryable: true });
      return { summary, completion };
    } catch (err) {
      lastError = describeError(err);
      const retryable = (err as { retryable?: boolean }).retryable === true || err instanceof TypeError || /timeout|abort|fetch/i.test(lastError);
      if (attempt === ATTEMPTS || !retryable) throw new Error(lastError);
      log("0G attempt failed, retrying", { attempt, error: lastError });
      await new Promise((r) => setTimeout(r, 3_000 * attempt));
    }
  }
  throw new Error(lastError);
}

/**
 * Explains one detected implementation change, and publishes the note.
 *
 * Returns a result for every outcome rather than throwing, so the caller can log it and carry on.
 * The caller must already have written the change itself to Arkiv: nothing in here is on the
 * critical path for detection.
 */
export async function explainChange(change: ChangeToExplain, deps: ExplainDeps): Promise<ExplainResult> {
  const env = deps.env ?? process.env;
  const { log } = deps;

  if (!env.ZEROG_API_KEY) return { state: "skipped", reason: "ZEROG_API_KEY is not set, so no explanation can be generated" };
  const writerKey = env.ARKIV_WRITER_PRIVATE_KEY;
  if (!writerKey || !isHex(writerKey)) return { state: "skipped", reason: "ARKIV_WRITER_PRIVATE_KEY is not set, so a change note cannot be published" };

  const from = getAddress(change.from);
  const to = getAddress(change.to);
  if (from.toLowerCase() === to.toLowerCase()) return { state: "skipped", reason: "the implementation did not actually move" };

  const arkiv = arkivFor(env);

  // ---- 1. have we already explained exactly this change? -------------------------------------
  // Keyed on (chain, address, from, to, block), not just the contract: a second A→B→A upgrade is
  // a different change and deserves its own note, but a retry of the same one must not spend
  // another 0G call or replace a good note with an identical one.
  try {
    const existing = await arkiv
      .select()
      .from(ChangeNoteSchema)
      .where(and(eq("chain_id", u64(BigInt(change.chainId))), eq("address", addr(change.address))))
      .createdBy(TRUSTED_CREATORS.writer)
      .limit(20)
      .fetch();
    const match = existing.entities.find(
      (n) =>
        n.from_implementation.value.toLowerCase() === from.toLowerCase() &&
        n.to_implementation.value.toLowerCase() === to.toLowerCase() &&
        n.change_block.value === change.changeBlock,
    );
    if (match) return { state: "already-explained", entityKey: match.$key };
  } catch (err) {
    // Not fatal: worst case we generate a note that already exists. Say so rather than hide it.
    log("could not check for an existing change note (continuing)", { error: describeError(err) });
  }

  // ---- 2. selectors from deployed bytecode ---------------------------------------------------
  let diff: ReturnType<typeof diffSelectors>;
  let names: Record<string, string>;
  try {
    const client = deps.clientFor(change.chainId);
    const [codeFrom, codeTo] = await Promise.all([client.getCode({ address: from }), client.getCode({ address: to })]);
    if (!codeFrom || codeFrom === "0x") return { state: "skipped", reason: `the previous implementation ${from} has no deployed code to compare` };
    if (!codeTo || codeTo === "0x") return { state: "skipped", reason: `the new implementation ${to} has no deployed code to compare` };
    diff = diffSelectors(withoutErrorSelectors(selectorsFromBytecode(codeFrom)), withoutErrorSelectors(selectorsFromBytecode(codeTo)));
    names = await resolveNames([...diff.added, ...diff.removed, ...diff.kept]);
  } catch (err) {
    return { state: "failed", stage: "bytecode", message: describeError(err) };
  }

  const show = (s: Selector) => (names[s] ? `${s} ${names[s]}` : `${s} (unknown signature)`);
  const facts = [
    `Chain id: ${change.chainId}`,
    `Proxy: ${change.address}`,
    `Previous implementation: ${from}`,
    `New implementation: ${to}`,
    "",
    `Functions only in the PREVIOUS code (${diff.removed.length}): ${diff.removed.map(show).join("; ") || "none"}`,
    `Functions only in the NEW code (${diff.added.length}): ${diff.added.map(show).join("; ") || "none"}`,
    `Present in both (${diff.kept.length}): ${diff.kept.map(show).join("; ") || "none"}`,
  ].join("\n");

  // ---- 3. ask 0G ------------------------------------------------------------------------------
  let summary: string;
  let completion: Completion;
  const t0 = Date.now();
  try {
    ({ summary, completion } = await ask0G(facts, env, log));
  } catch (err) {
    return { state: "failed", stage: "zerog", message: describeError(err) };
  }
  const trace = completion.x_0g_trace ?? {};
  const model = completion.model ?? env.ZEROG_MODEL ?? DEFAULT_MODEL;
  log("0G answered", { requestId: trace.request_id, model, provider: trace.provider, ms: Date.now() - t0, chars: summary.length });

  // ---- 4. text to Swarm, verified by re-download ---------------------------------------------
  const bytes = stringToBytes(summary);
  const summaryHash = keccak256(bytes);
  let swarmRef: string;
  try {
    const up = await fetch(`${PUBLIC_GATEWAY}/bytes`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from(bytes),
      signal: AbortSignal.timeout(60_000),
    });
    if (up.status !== 200 && up.status !== 201) throw new Error(`Swarm upload HTTP ${up.status}: ${(await up.text()).slice(0, 200)}`);
    swarmRef = String(((await up.json()) as { reference?: string }).reference ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(swarmRef)) throw new Error(`unexpected Swarm reference: ${swarmRef}`);
    const back = await fetch(`${PUBLIC_GATEWAY}/bytes/${swarmRef}`, { signal: AbortSignal.timeout(30_000) });
    if (keccak256(new Uint8Array(await back.arrayBuffer())) !== summaryHash) {
      throw new Error("Swarm returned different bytes than were uploaded; refusing to record the reference");
    }
  } catch (err) {
    return { state: "failed", stage: "swarm", message: describeError(err) };
  }

  // ---- 5. facts + hash on Arkiv --------------------------------------------------------------
  try {
    const wallet = createWalletClient({
      account: privateKeyToAccount(writerKey),
      chain: rabdi({ accessKey: env.ARKIV_ACCESS_KEY ?? "" }),
      transport: http(),
    });
    // One note per contract: the previous one goes in the same transaction, so a reader never
    // sees two notes for the same proxy.
    const stale = await arkiv
      .select({ $key: true })
      .from(ChangeNoteSchema)
      .where(and(eq("chain_id", u64(BigInt(change.chainId))), eq("address", addr(change.address))))
      .createdBy(TRUSTED_CREATORS.writer)
      .limit(20)
      .fetch();
    const res = await wallet.executeBatch({
      creates: [
        {
          schema: ChangeNoteSchema,
          values: {
            chain_id: u64(BigInt(change.chainId)),
            address: addr(change.address),
            from_implementation: addr(from),
            to_implementation: addr(to),
            change_block: u64(change.changeBlock),
            summary_hash: summaryHash as string,
            summary_swarm_ref: swarmRef,
            selectors_added: u64(BigInt(diff.added.length)),
            selectors_removed: u64(BigInt(diff.removed.length)),
            same_surface: sameSurface(diff),
            model,
            zerog_request_id: trace.request_id ?? "",
            zerog_provider: trace.provider ?? "",
            cost_usd_micro: u64(BigInt(trace.billing?.total_cost_usd_micro ?? "0")),
            generated_at: u64(BigInt(Math.floor(Date.now() / 1000))),
          },
          expiration: ExpirationTime.max(),
        },
      ],
      deletes: stale.entities.map((n) => ({ entityKey: n.$key })),
    });
    const entityKey = res.createdEntities[0]!;
    log("change note published", { chainId: change.chainId, address: change.address, entityKey, swarmRef, requestId: trace.request_id, arkivTx: res.txHash });
    return {
      state: "published",
      requestId: trace.request_id ?? "",
      model,
      swarmRef,
      summaryHash,
      entityKey,
      costUsdMicro: Number(trace.billing?.total_cost_usd_micro ?? "0"),
    };
  } catch (err) {
    // The text is on Swarm but unreferenced. Honest, and a rerun will re-upload to the same
    // content address, so nothing is lost.
    return { state: "failed", stage: "arkiv", message: describeError(err) };
  }
}

/**
 * Explains every implementation change from one cycle, in series.
 *
 * In series on purpose: each note costs a 0G call and an Arkiv transaction, and a burst of
 * upgrades should not fan out into concurrent spend. Every outcome is logged; nothing is thrown,
 * because the caller has already finished the part of the job that matters.
 */
export async function explainCycleChanges(
  changes: readonly { chainId: number; address: Address; field: string; previousValue: string; newValue: string; changeBlock: bigint }[],
  deps: ExplainDeps,
): Promise<void> {
  const env = deps.env ?? process.env;
  // Only an implementation move has two bytecodes to diff. A facets change carries no address,
  // and an admin change does not alter which code runs.
  const explainable = changes.filter(
    (c) => c.field === "implementation" && /^0x[0-9a-fA-F]{40}$/.test(c.previousValue) && /^0x[0-9a-fA-F]{40}$/.test(c.newValue),
  );
  if (explainable.length === 0) return;
  if (!explainConfigured(env)) {
    deps.log("change detected but explanations are not configured", {
      changes: explainable.length,
      missing: [!env.ZEROG_API_KEY && "ZEROG_API_KEY", !env.ARKIV_WRITER_PRIVATE_KEY && "ARKIV_WRITER_PRIVATE_KEY"].filter(Boolean).join(", "),
    });
    return;
  }

  for (const c of explainable) {
    try {
      const result = await explainChange(
        { chainId: c.chainId, address: c.address, from: getAddress(c.previousValue), to: getAddress(c.newValue), changeBlock: c.changeBlock },
        deps,
      );
      if (result.state === "failed") {
        // Loudly, and never swallowed: the change itself is already recorded, but a reader will
        // see "no explanation available" and the reason has to be somewhere.
        deps.log("change explanation failed", { chainId: c.chainId, address: c.address, stage: result.stage, error: result.message });
      } else if (result.state === "skipped") {
        deps.log("change explanation skipped", { chainId: c.chainId, address: c.address, reason: result.reason });
      } else if (result.state === "already-explained") {
        deps.log("change already explained", { chainId: c.chainId, address: c.address, entityKey: result.entityKey });
      }
    } catch (err) {
      deps.log("change explanation threw", { chainId: c.chainId, address: c.address, error: describeError(err) });
    }
  }
}

/** Expiry note: change notes are long-lived like baselines. EXPIRY is re-exported for renew.ts. */
export { EXPIRY };
