/**
 * Classifies how a contract decides which code runs, by reading its proxy slots at one block.
 * Shared by the monitored-set selection, the importer's dg_deployment.proxy_kind, and the web
 * app's "Add a contract" inspection.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. There are three different answers, and collapsing any two
 * of them is a bug:
 *
 *   "not a proxy"        — we read everything we know how to read, and none of it is a proxy.
 *   "a proxy Argos can't read" — it *is* a proxy; its upgrade mechanism is not one we can monitor.
 *   "we don't know"      — a read failed, so no claim is available.
 *
 * Before 2026-11-06 all three came back as `none`, which the UI renders as "not a proxy". USDC
 * (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) reproduced it: a pre-EIP-1967 OpenZeppelin proxy
 * read as an ordinary contract. A node that declines a slot read reproduced it too, because
 * `readAddressSlot` turned a missing answer into a zero slot. Both are fixed; the shapes below
 * exist so a caller cannot accidentally re-merge them.
 *
 * WHAT IS *NOT* EVIDENCE. A DELEGATECALL anywhere in the runtime bytecode is not a proxy signal:
 * WETH (0xC02a…6Cc2) and LINK (0x5149…86CA) both contain one and neither is a proxy. It counts
 * only inside bytecode small enough to be nothing but a forwarder, and even then only as
 * "unreadable proxy", never as a detected implementation.
 */
import { parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { readAddressSlot, readCodehash, SlotReadError } from "./read.ts";
import {
  BEACON_SLOT,
  EIP1822_PROXIABLE_SLOT,
  eip1167Implementation,
  IMPLEMENTATION_SLOT,
  SAFE_SINGLETON_SLOT,
  ZEPPELINOS_IMPLEMENTATION_SLOT,
} from "./slots.ts";
import type { ProxyKind } from "./identity.ts";

/**
 * What an inspection concluded. Distinct from {@link ProxyKind}, which is the smaller set of
 * mechanisms the watcher knows how to *monitor*.
 */
export type Architecture =
  /** EIP-1967 implementation slot: transparent and UUPS proxies both live here. */
  | "eip1967"
  /** Pre-EIP-1967 OpenZeppelin AdminUpgradeabilityProxy. */
  | "zeppelinos"
  /** EIP-1967 beacon slot, then `beacon.implementation()`. */
  | "beacon"
  /** EIP-2535 diamond, identified by its loupe. */
  | "diamond"
  /** Safe proxy: singleton in slot 0. */
  | "safe"
  /** Canonical EIP-1167 clone. Immutable: the implementation is in the code, not in storage. */
  | "eip1167"
  /** Demonstrably a proxy, by a mechanism Argos cannot read well enough to monitor. */
  | "unsupported-proxy"
  /** Inspected successfully, and not a proxy by any mechanism Argos probes. */
  | "none"
  /** EIP-7702: an EOA pointing at delegate code. Not a contract and not a proxy. */
  | "delegated-eoa"
  /** Nothing deployed at this address. */
  | "no-code";

/** One probe's result, in the order the probes ran, so a conclusion can be shown as a chain. */
export interface Probe {
  /** e.g. "eip1967.implementation", "eip1167.runtime", "loupe.facets()" */
  name: string;
  /** what the probe found, already rendered for display */
  result: string;
  decisive: boolean;
}

export interface Inspection {
  architecture: Architecture;
  /**
   * How the watcher would monitor it, or `null` when Argos cannot. `eip1167` and `none` both
   * monitor by the address's own codehash, which is why both map to `"none"`.
   */
  monitorAs: ProxyKind | null;
  /** Zero when the architecture has no single implementation address (diamond, none). */
  implementation: Address;
  /** Bytes of deployed runtime code at the address. */
  codeSize: number;
  probes: Probe[];
  /** Plain-language reason, always set for `unsupported-proxy`, `none` and `delegated-eoa`. */
  reason: string;
}

/**
 * Raised when a probe could not be completed, so no classification is available. Callers must
 * surface this as "not verified" / "RPC error" and never as a classification.
 */
export class InspectionError extends Error {
  readonly probe: string;
  constructor(probe: string, cause: unknown) {
    super(`proxy inspection failed at ${probe}: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`);
    this.name = "InspectionError";
    this.probe = probe;
    this.cause = cause;
  }
}

const loupe = parseAbi(["function facets() view returns ((address facetAddress, bytes4[] functionSelectors)[])"]);
const beaconAbi = parseAbi(["function implementation() view returns (address)"]);

/** EIP-7702 delegation indicator: 23 bytes of 0xef0100 ++ address. */
const EIP7702 = /^0xef0100[0-9a-f]{40}$/i;

/** Bytecode no larger than this is small enough that a DELEGATECALL in it means "forwarder". */
const FORWARDER_MAX_BYTES = 200;

const short = (a: Address) => `${a.slice(0, 10)}…${a.slice(-8)}`;

/**
 * A slot read, where a zero slot is an answer ("not this kind") and a missing answer is not.
 * {@link SlotReadError} is re-raised as {@link InspectionError} so the caller reports RPC trouble;
 * any other failure (an archive node refusing a historical slot, say) does the same.
 */
async function slot(client: PublicClient, address: Address, s: Hex, block: bigint, probe: string): Promise<Address> {
  try {
    return await readAddressSlot(client, address, s, block);
  } catch (err) {
    throw new InspectionError(probe, err);
  }
}

/** True when `code` contains a DELEGATECALL opcode, skipping PUSH operands so push data can't fake one. */
export function hasDelegatecall(code: string): boolean {
  const hex = code.startsWith("0x") ? code.slice(2) : code;
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return false;
  for (let i = 0; i < hex.length / 2; i++) {
    const op = Number.parseInt(hex.substr(i * 2, 2), 16);
    if (op === 0xf4) return true;
    if (op >= 0x60 && op <= 0x7f) i += op - 0x60 + 1; // skip PUSHn operand
  }
  return false;
}

/**
 * Full inspection at one block. Throws {@link InspectionError} if a probe could not be run —
 * it never degrades an unanswered read into a classification.
 */
export async function inspectContract(client: PublicClient, address: Address, blockNumber: bigint): Promise<Inspection> {
  const probes: Probe[] = [];
  const add = (name: string, result: string, decisive = false) => probes.push({ name, result, decisive });

  let code: string;
  try {
    code = (await client.getCode({ address, blockNumber })) ?? "0x";
  } catch (err) {
    throw new InspectionError("eth_getCode", err);
  }
  const codeSize = code === "0x" ? 0 : (code.length - 2) / 2;
  add("eth_getCode", `${codeSize} bytes`);

  if (codeSize === 0) {
    return {
      architecture: "no-code", monitorAs: null, implementation: zeroAddress, codeSize, probes,
      reason: "There is no contract code at this address on this network. It is an externally owned account, or the contract is on a different network.",
    };
  }

  if (EIP7702.test(code)) {
    const target = `0x${code.slice(8)}` as Address;
    add("eip7702.delegation", short(target), true);
    return {
      architecture: "delegated-eoa", monitorAs: null, implementation: target, codeSize, probes,
      reason: `This is an externally owned account with an EIP-7702 delegation to ${target}, not a contract. Its owner can change or remove the delegation with an ordinary transaction, so Argos has no upgrade mechanism to baseline.`,
    };
  }

  // ---- the slot reads, all at once -----------------------------------------------------------
  // Four independent storage reads. They used to run one after another, which cost four
  // round trips — fine against a local node, painful through the Nym mixnet, where each hop is
  // seconds. Precedence still decides the *answer* below; it never needed to decide the reads.
  // Promise.all rejects on the first failure, which is the behaviour wanted: a probe that could
  // not be run must raise InspectionError rather than contribute a "not this kind" answer.
  const [impl, beacon, legacy, proxiable] = await Promise.all([
    slot(client, address, IMPLEMENTATION_SLOT, blockNumber, "eip1967.implementation"),
    slot(client, address, BEACON_SLOT, blockNumber, "eip1967.beacon"),
    slot(client, address, ZEPPELINOS_IMPLEMENTATION_SLOT, blockNumber, "zeppelinos.implementation"),
    slot(client, address, EIP1822_PROXIABLE_SLOT, blockNumber, "eip1822.proxiable"),
  ]);

  // ---- 1. EIP-1967 implementation slot (transparent and UUPS) --------------------------------
  if (impl !== zeroAddress) {
    const hash = await readCodehash(client, impl, blockNumber).catch((err: unknown) => {
      throw new InspectionError("eip1967.implementation codehash", err);
    });
    const empty = /^0x0{64}$/i.test(hash);
    add("eip1967.implementation", `${short(impl)}${empty ? " (no code!)" : ""}`, true);
    // A non-zero slot pointing at an address with no code is still a proxy — a broken one. Say so
    // rather than falling through to "not a proxy", which would be plainly wrong.
    return empty
      ? {
          architecture: "unsupported-proxy", monitorAs: null, implementation: impl, codeSize, probes,
          reason: `The EIP-1967 implementation slot holds ${impl}, but nothing is deployed there at block ${blockNumber}. Calls to this proxy cannot succeed, and there is no implementation code for Argos to baseline.`,
        }
      : { architecture: "eip1967", monitorAs: "eip1967", implementation: impl, codeSize, probes, reason: "" };
  }
  add("eip1967.implementation", "empty");

  // ---- 2. EIP-1967 beacon slot ---------------------------------------------------------------
  if (beacon !== zeroAddress) {
    add("eip1967.beacon", short(beacon), true);
    const bi = await client
      .readContract({ address: beacon, abi: beaconAbi, functionName: "implementation", blockNumber })
      .catch(() => null);
    if (bi === null || bi === zeroAddress) {
      add("beacon.implementation()", bi === null ? "reverted" : "zero");
      return {
        architecture: "unsupported-proxy", monitorAs: null, implementation: zeroAddress, codeSize, probes,
        reason: `The EIP-1967 beacon slot holds ${beacon}, so this is a beacon proxy, but that beacon does not answer implementation(). Argos reads a beacon proxy's code through its beacon, so it cannot tell which code runs here.`,
      };
    }
    add("beacon.implementation()", short(bi));
    return { architecture: "beacon", monitorAs: "beacon", implementation: bi, codeSize, probes, reason: "" };
  }
  add("eip1967.beacon", "empty");

  // ---- 3. pre-EIP-1967 OpenZeppelin slot -----------------------------------------------------
  if (legacy !== zeroAddress) {
    const hash = await readCodehash(client, legacy, blockNumber).catch(() => "0x" as Hex);
    if (!/^0x0{64}$/i.test(hash)) {
      add("zeppelinos.implementation", short(legacy), true);
      return { architecture: "zeppelinos", monitorAs: "zeppelinos", implementation: legacy, codeSize, probes, reason: "" };
    }
    add("zeppelinos.implementation", `${short(legacy)} (no code)`);
  } else {
    add("zeppelinos.implementation", "empty");
  }

  // ---- 4. EIP-2535 diamond -------------------------------------------------------------------
  const facets = await client.readContract({ address, abi: loupe, functionName: "facets", blockNumber }).catch(() => null);
  if (facets && facets.length > 0) {
    add("loupe.facets()", `${facets.length} facets`, true);
    return { architecture: "diamond", monitorAs: "diamond", implementation: zeroAddress, codeSize, probes, reason: "" };
  }
  add("loupe.facets()", facets ? "no facets" : "not a loupe");

  // ---- 5. EIP-1167 minimal proxy (immutable) -------------------------------------------------
  const clone = eip1167Implementation(code);
  if (clone) {
    add("eip1167.runtime", `canonical 45-byte clone of ${short(clone)}`, true);
    return {
      architecture: "eip1167", monitorAs: "none", implementation: clone, codeSize, probes,
      reason: `This is a canonical EIP-1167 minimal proxy delegating to ${clone}. The address is spliced into the clone's own bytecode rather than held in storage, so it cannot be upgraded — Argos monitors it by the clone's codehash, which changes only if something is redeployed to this address.`,
    };
  }

  // ---- 6. Safe proxy: tiny bytecode delegating to the singleton in slot 0 --------------------
  if (codeSize < 400) {
    const s0 = await slot(client, address, SAFE_SINGLETON_SLOT, blockNumber, "safe.singleton");
    if (s0 !== zeroAddress) {
      const s0code = (await client.getCode({ address: s0, blockNumber }).catch(() => "0x")) ?? "0x";
      if (s0code !== "0x") {
        add("safe.singleton", short(s0), true);
        return { architecture: "safe", monitorAs: "safe", implementation: s0, codeSize, probes, reason: "" };
      }
    }
    add("safe.singleton", s0 === zeroAddress ? "empty" : "no code at the singleton");
  }

  // ---- 7. evidence that it is a proxy we cannot read -----------------------------------------
  if (proxiable !== zeroAddress) {
    const hash = await readCodehash(client, proxiable, blockNumber).catch(() => "0x" as Hex);
    if (!/^0x0{64}$/i.test(hash)) {
      add("eip1822.proxiable", short(proxiable), true);
      return {
        architecture: "unsupported-proxy", monitorAs: null, implementation: proxiable, codeSize, probes,
        reason: `The EIP-1822 PROXIABLE slot holds ${proxiable}, which has code, so this looks like an EIP-1822 delegate proxy. EIP-1822 was withdrawn in favour of EIP-1967 and its slot is also used by unrelated contracts, so Argos will not treat the value as authoritative and does not monitor this pattern.`,
      };
    }
  }
  add("eip1822.proxiable", "empty");

  // A forwarder-sized contract whose only job can be to DELEGATECALL somewhere we could not find.
  if (codeSize <= FORWARDER_MAX_BYTES && hasDelegatecall(code)) {
    add("bytecode.delegatecall", `present in ${codeSize} bytes`, true);
    return {
      architecture: "unsupported-proxy", monitorAs: null, implementation: zeroAddress, codeSize, probes,
      reason: `Only ${codeSize} bytes of code are deployed here and they contain a DELEGATECALL, so this address almost certainly forwards calls to another contract — but it holds its target somewhere Argos does not know how to read (a custom storage slot, an immutable in a non-canonical clone, or a getter). Argos cannot tell which code runs, so it will not baseline it.`,
    };
  }

  return {
    architecture: "none", monitorAs: "none", implementation: zeroAddress, codeSize, probes,
    reason: `${codeSize} bytes of code are deployed here, and none of the upgrade mechanisms Argos probes are present: the EIP-1967 implementation and beacon slots are empty, the pre-EIP-1967 OpenZeppelin slot is empty, it is not an EIP-2535 diamond, not a canonical EIP-1167 clone, and not a Safe proxy. Argos monitors it by its own codehash.`,
  };
}

export type Classification = ProxyKind | "no-code";

/**
 * The narrow, long-standing shape: just the kind and the implementation.
 *
 * Kept because the importer stores one string per deployment, and because the monitored-set
 * selection only cares whether a contract is watchable. `unsupported-proxy`, `delegated-eoa` and
 * a genuine non-proxy all come back as `none` here, which is why anything that *shows a verdict
 * to a person* must call {@link inspectContract} instead.
 */
export async function classifyContract(
  client: PublicClient,
  address: Address,
  blockNumber: bigint,
): Promise<{ kind: Classification; implementation: Address }> {
  const r = await inspectContract(client, address, blockNumber);
  return { kind: r.architecture === "no-code" ? "no-code" : (r.monitorAs ?? "none"), implementation: r.implementation };
}
