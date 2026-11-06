/**
 * Transaction-time protection, lifted out of the old Check screen so the contract workspace can
 * use it directly. Unchanged in behaviour: it asks the deployed ArgosGuard what it *would* do via
 * its own `wouldSucceed` view, rather than reimplementing the check in TypeScript, so this panel
 * cannot drift from what `checkAndCall` actually enforces on chain.
 *
 * It is still only a preview. The implementation can change between this read and the
 * transaction, which is the entire reason `checkAndCall` re-checks inside the transaction.
 */
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { clientFor } from "./chain.ts";
import { GUARD_DEMO } from "./config.ts";

export const guardAbi = parseAbi([
  "function checkAndCall(address proxy, address expectedImplementation, bytes data) payable returns (bytes)",
  "function wouldSucceed(address proxy, address expectedImplementation) view returns (bool supported, bool matches, address actual)",
  "error ImplementationChanged(address proxy, address expected, address actual)",
  "error ImplementationChangedDuringCall(address proxy, address expected, address actual)",
  "error UnsupportedProxy(address proxy)",
  "error InvalidExpectedImplementation()",
]);

/**
 *  VERIFIED     the proxy exposes a trustworthy getter and its implementation matches the baseline
 *  BLOCKED      supported, but the implementation changed — the guarded call reverts
 *  UNSUPPORTED  no proxy-level getter, so no atomic check is possible for this contract
 *  NOT_VERIFIED the current implementation could not be established (RPC failed, no baseline)
 */
export type GuardStatus = "VERIFIED" | "BLOCKED" | "UNSUPPORTED" | "NOT_VERIFIED";

export interface GuardSim {
  status: GuardStatus;
  expected: Address | null;
  actual: Address | null;
  guardedData: Hex | null;
  block: bigint;
  error?: string;
}

export async function simulateGuard(
  chainId: number,
  to: string,
  data: Hex,
  expected: Address | null,
): Promise<GuardSim> {
  const client = clientFor(chainId);
  const block = await client.getBlockNumber().catch(() => 0n);

  if (chainId !== GUARD_DEMO.chainId) {
    // The guard is a controlled demo deployed only on Sepolia. UNSUPPORTED is the honest answer
    // for every mainnet registry contract, and would stay true even if we deployed one there:
    // none of them expose a proxy-level implementation getter.
    return { status: "UNSUPPORTED", expected, actual: null, guardedData: null, block, error: "no Argos guard is deployed on this chain" };
  }
  if (!expected) {
    return { status: "NOT_VERIFIED", expected: null, actual: null, guardedData: null, block, error: "no Argos baseline for this contract" };
  }

  const guardedData = encodeFunctionData({
    abi: guardAbi,
    functionName: "checkAndCall",
    args: [getAddress(to), expected, data],
  });
  try {
    const [supported, matches, actual] = await client.readContract({
      address: GUARD_DEMO.guard,
      abi: guardAbi,
      functionName: "wouldSucceed",
      args: [getAddress(to), expected],
    });
    if (!supported) return { status: "UNSUPPORTED", expected, actual: null, guardedData, block };
    return { status: matches ? "VERIFIED" : "BLOCKED", expected, actual, guardedData, block };
  } catch (err) {
    return {
      status: "NOT_VERIFIED",
      expected,
      actual: null,
      guardedData,
      block,
      error: (err instanceof Error ? err.message : String(err)).split("\n")[0]!,
    };
  }
}

export const GUARD_COPY: Record<GuardStatus, { label: string; tone: "ok" | "bad" | "warn" | "neutral"; blurb: string }> = {
  VERIFIED: { label: "Verified", tone: "ok", blurb: "The expected implementation would still match when the call executes." },
  BLOCKED: { label: "Blocked", tone: "bad", blurb: "The implementation changed. The guard would revert and the call would not run." },
  UNSUPPORTED: { label: "Unsupported", tone: "neutral", blurb: "Atomic protection is not available for this contract." },
  NOT_VERIFIED: { label: "Not verified", tone: "warn", blurb: "The current implementation could not be established." },
};
