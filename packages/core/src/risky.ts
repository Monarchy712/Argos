/**
 * Calldata patterns that change which code runs, flagged independently of any descriptor. These
 * are informational: they say what the transaction does mechanically, not whether it is wanted.
 */
import { decodeFunctionData, parseAbi, toFunctionSelector, type Hex } from "viem";

export interface RiskFlag {
  id: string;
  title: string;
  detail: string;
}

const UPGRADE_SIGS = [
  "upgradeTo(address)",
  "upgradeToAndCall(address,bytes)",
  "upgrade(address,address)",
  "upgradeAndCall(address,address,bytes)",
  "changeAdmin(address)",
  "changeProxyAdmin(address,address)",
  "changeMasterCopy(address)",
  "diamondCut((address,uint8,bytes4[])[],address,bytes)",
] as const;

const UPGRADE_SELECTORS = new Map(UPGRADE_SIGS.map((s) => [toFunctionSelector(`function ${s}`), s]));

const safeAbi = parseAbi([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);
const EXEC_TRANSACTION = toFunctionSelector(safeAbi[0]);

function upgradeFlag(sig: string, where: string): RiskFlag {
  const what = sig.startsWith("changeAdmin") || sig.startsWith("changeProxyAdmin")
    ? "changes who can upgrade a proxy"
    : sig.startsWith("changeMasterCopy")
      ? "changes a Safe's singleton (the code the Safe runs)"
      : sig.startsWith("diamondCut")
        ? "adds, replaces or removes diamond facets (the code the diamond runs)"
        : "points a proxy at a new implementation";
  return { id: `upgrade:${sig}`, title: `Code change: ${sig.split("(")[0]}`, detail: `${where}This call ${what}.` };
}

/** Flags for one call; looks one level into Safe execTransaction payloads. */
export function riskyCalldataFlags(data: Hex): RiskFlag[] {
  if (!data || data.length < 10) return [];
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  const flags: RiskFlag[] = [];

  const sig = UPGRADE_SELECTORS.get(selector);
  if (sig) flags.push(upgradeFlag(sig, ""));

  if (selector === EXEC_TRANSACTION) {
    try {
      const { args } = decodeFunctionData({ abi: safeAbi, data });
      const [to, , inner, operation] = args;
      if (operation === 1) {
        flags.push({
          id: "safe:delegatecall",
          title: "Safe transaction uses DELEGATECALL (operation = 1)",
          detail: `The Safe will run code from ${to} in its own context, with full access to its storage and funds.`,
        });
      }
      const innerSig = inner.length >= 10 ? UPGRADE_SELECTORS.get(inner.slice(0, 10).toLowerCase() as Hex) : undefined;
      if (innerSig) flags.push(upgradeFlag(innerSig, `Inside this Safe transaction (to ${to}): `));
    } catch {
      // not a well-formed execTransaction; the selector match alone isn't flagged
    }
  }
  return flags;
}
