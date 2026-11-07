/**
 * Publishing a `dg_baseline` row on behalf of a person using the web app.
 *
 * WHY THIS LIVES SERVER-SIDE. A baseline is signed with ARKIV_WRITER_PRIVATE_KEY, one of the two
 * wallets every Argos client trusts (packages/core/src/trust.ts). If the browser held that key,
 * anyone could publish a row the whole system treats as authoritative. So the browser sends a
 * request and this publishes the record — the key never leaves the server, is never returned in a
 * response, and is never logged.
 *
 * WHY THE REQUEST CARRIES NO EVIDENCE. The browser sends only `{ chainId, address }`. Everything
 * that ends up in the row — the architecture, the implementation, the codehash, the block, the
 * code identity — is read here, from this server's own RPC. A client-supplied identity would let
 * a caller publish a baseline that matches code that was never deployed, and every later
 * comparison would be against a fiction. The person's *decision* is the input; the facts are not.
 *
 * WHAT "PUBLISHED" MEANS. The row is created, then read back by (chain, address) and its
 * `code_identity` compared with what was written. Only then does this return `published`. A
 * create whose read-back disagrees is reported as `unverified`, never as success.
 */
import { codeIdentityHash, inspectContract, readIdentity, describeError, type CodeIdentity } from "@driftguard/core";
import { getAddress, isAddress, type Address, type Hex, type PublicClient } from "viem";
import type { ArkivSink } from "./arkivSink.ts";
import type { WatcherConfig } from "./config.ts";

/** Chains the watcher has an RPC for, and therefore can monitor. */
export const PUBLISHABLE_CHAINS = [1, 11155111] as const;

export interface PublishRequest {
  chainId: number;
  address: string;
  /** Set to replace an existing baseline. Requires `reason`. */
  rebaseline?: boolean;
  /** Free text recorded in `rebaseline_reason`, so the row says why it exists. */
  reason?: string;
}

export type PublishResult =
  /** The row is on Arkiv and has been read back. */
  | { state: "published"; entityKey: string; chainId: number; address: Address; identity: CodeIdentity; identityHash: Hex; block: string; architecture: string; verifiedAt: number }
  /** A baseline already exists and `rebaseline` was not set. Not an error; the contract is monitored. */
  | { state: "already-monitored"; entityKey: string; chainId: number; address: Address; identityHash: Hex; block: string }
  /** The request will not be published, and why. Retrying unchanged will not help. */
  | { state: "rejected"; code: RejectCode; message: string }
  /** The write landed but the read-back did not confirm it. Never reported as monitored. */
  | { state: "unverified"; message: string; entityKey?: string }
  /** The publication could not be attempted or did not complete. Retrying may help. */
  | { state: "failed"; message: string };

export type RejectCode =
  | "invalid-address"
  | "unsupported-chain"
  | "not-inspectable"
  | "not-monitorable"
  | "empty-implementation"
  | "rebaseline-needs-reason";

const rejected = (code: RejectCode, message: string): PublishResult => ({ state: "rejected", code, message });

/**
 * Validates, inspects, publishes and verifies. Returns a result for every outcome rather than
 * throwing, so the caller can map each one to its own HTTP status and its own UI state.
 */
export async function publishBaseline(
  req: PublishRequest,
  deps: { sink: ArkivSink; clientFor: (chainId: number) => PublicClient; config: WatcherConfig; log: (msg: string, data?: Record<string, unknown>) => void },
): Promise<PublishResult> {
  const { sink, clientFor, config, log } = deps;

  // ---- 1. validate the request, before any network call --------------------------------------
  const raw = typeof req.address === "string" ? req.address.trim() : "";
  if (!isAddress(raw)) {
    // Distinguish the two reasons: viem accepts an all-lower or all-upper address and rejects a
    // mixed-case one whose EIP-55 checksum does not match, which is a typo, not a bad format.
    const wellFormed = /^0x[0-9a-fA-F]{40}$/.test(raw);
    return rejected(
      "invalid-address",
      wellFormed
        ? "That address is 20 bytes of hex but its EIP-55 checksum does not match, which usually means a character was mistyped. Check it, or paste it in all lower case."
        : "The address must be a 20-byte hex address (0x followed by 40 hex characters).",
    );
  }
  if (!(PUBLISHABLE_CHAINS as readonly number[]).includes(req.chainId)) {
    return rejected("unsupported-chain", `Argos monitors chains ${PUBLISHABLE_CHAINS.join(" and ")}; it has no RPC for chain ${req.chainId}.`);
  }
  if (req.rebaseline && !(req.reason ?? "").trim()) {
    return rejected("rebaseline-needs-reason", "Replacing a baseline requires a reason, so the row records why the trust anchor moved.");
  }
  const address = getAddress(raw);
  const chainId = req.chainId;

  // ---- 2. existing baseline ------------------------------------------------------------------
  let existing;
  try {
    existing = await sink.readBaseline(chainId, address);
  } catch (err) {
    return { state: "failed", message: `Could not read existing baselines from Arkiv: ${describeError(err)}` };
  }
  if (existing && !req.rebaseline) {
    return {
      state: "already-monitored",
      entityKey: existing.key,
      chainId,
      address,
      identityHash: existing.identityHash,
      block: existing.block.toString(),
    };
  }

  // ---- 3. inspect, on this server's own RPC --------------------------------------------------
  let client: PublicClient;
  try {
    client = clientFor(chainId);
  } catch (err) {
    return { state: "failed", message: `No usable RPC for chain ${chainId}: ${describeError(err)}` };
  }

  let block: bigint;
  let architecture: string;
  let monitorAs: Awaited<ReturnType<typeof inspectContract>>["monitorAs"];
  let reasonWhyNot = "";
  try {
    block = (await client.getBlockNumber()) - config.confirmations;
    const ins = await inspectContract(client, address, block);
    architecture = ins.architecture;
    monitorAs = ins.monitorAs;
    reasonWhyNot = ins.reason;
  } catch (err) {
    // An inspection that did not complete is not a verdict about the contract.
    return { state: "failed", message: `Inspection did not complete, so nothing was published: ${describeError(err)}` };
  }

  if (!monitorAs) {
    return rejected("not-monitorable", reasonWhyNot || `Argos cannot read which code runs at this address (${architecture}), so a baseline would have nothing to compare against.`);
  }

  // ---- 4. read the identity that will become the trust anchor --------------------------------
  let identity: CodeIdentity;
  try {
    identity = await readIdentity(client, address, monitorAs, block);
  } catch (err) {
    return { state: "failed", message: `Could not read the contract's code identity, so nothing was published: ${describeError(err)}` };
  }

  // Refuse an empty baseline: it would make every later read look like a change (or hide one).
  // Same rule as `rebaseline` (watcher/src/rebaseline.ts), applied here so the API cannot bypass it.
  const needsImplementation = monitorAs === "eip1967" || monitorAs === "zeppelinos" || monitorAs === "beacon" || monitorAs === "safe";
  if (needsImplementation && /^0x0{40}$/i.test(identity.implementation)) {
    return rejected("empty-implementation", `The ${monitorAs} implementation slot is empty at block ${block}, so there is no implementation to baseline.`);
  }
  if (monitorAs !== "diamond" && /^0x0{64}$/i.test(identity.implementationCodehash)) {
    return rejected("empty-implementation", `There is no code at the implementation this address points to at block ${block}, so there is nothing to baseline.`);
  }

  const identityHash = codeIdentityHash(identity);

  // ---- 5. write -------------------------------------------------------------------------------
  const reason = (req.reason ?? "").trim() || (existing ? "rebaselined via the Argos web app" : "baselined via the Argos web app");
  let entityKey: string;
  try {
    entityKey = await sink.writeBaseline({
      chainId,
      address,
      identity,
      identityHash,
      block,
      baselinedAt: Math.floor(Date.now() / 1000),
      // The descriptor binding comes from the registry mirror, which is keyed by (chain, address)
      // already; a baseline does not restate it. Left empty exactly as `seed` leaves it.
      descriptorHash: "",
      swarmRef: "",
      reason: reason.slice(0, 120),
      previousKey: "",
    });
  } catch (err) {
    return { state: "failed", message: `The Arkiv write failed, so this contract is not monitored: ${describeError(err)}` };
  }

  // ---- 6. verify by reading the row back ------------------------------------------------------
  try {
    const back = await sink.readBaseline(chainId, address);
    if (!back) {
      return { state: "unverified", entityKey, message: "The write was accepted but no baseline could be read back for this contract. Do not treat it as monitored until a read succeeds." };
    }
    if (back.identityHash.toLowerCase() !== identityHash.toLowerCase()) {
      return { state: "unverified", entityKey: back.key, message: `The baseline read back from Arkiv has code identity ${back.identityHash}, not the ${identityHash} that was written.` };
    }
    log("baseline published", { chainId, address, architecture, monitorAs, block: block.toString(), entityKey: back.key });
    return {
      state: "published",
      entityKey: back.key,
      chainId,
      address,
      identity,
      identityHash,
      block: block.toString(),
      architecture,
      verifiedAt: Math.floor(Date.now() / 1000),
    };
  } catch (err) {
    return { state: "unverified", entityKey, message: `The write was accepted but could not be verified: ${describeError(err)}` };
  }
}
