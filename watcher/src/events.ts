import { parseAbi, type Address, type PublicClient } from "viem";
import type { ObservedEvent } from "./types.ts";

/**
 * Change events the watcher scans for. Signatures are from EIP-1967 / OpenZeppelin IERC1967,
 * EIP-2535 (DiamondCut) and Safe <=1.1.x MasterCopy (ChangedMasterCopy).
 */
export const CHANGE_EVENTS = parseAbi([
  "event Upgraded(address indexed implementation)",
  "event AdminChanged(address previousAdmin, address newAdmin)",
  "event BeaconUpgraded(address indexed beacon)",
  "event DiamondCut((address facetAddress, uint8 action, bytes4[] functionSelectors)[] _diamondCut, address _init, bytes _calldata)",
  "event ChangedMasterCopy(address masterCopy)",
]);

/** Which monitored contract a log emitter belongs to (a beacon's logs belong to its proxies). */
export type EmitterMap = Map<string, string[]>;

export interface ScannedEvent extends ObservedEvent {
  /** contractId(s) the event applies to. */
  contracts: string[];
}

/**
 * Fetches change events emitted by `emitters` in [fromBlock, toBlock], decoded and mapped to
 * identity fields. Always filters by address (some public RPCs reject unfiltered getLogs).
 */
export async function scanEvents(
  client: PublicClient,
  emitters: EmitterMap,
  fromBlock: bigint,
  toBlock: bigint,
  maxAddresses = 10,
): Promise<ScannedEvent[]> {
  if (emitters.size === 0 || fromBlock > toBlock) return [];
  // Public RPCs cap the address filter (PublicNode: "A maximum of 10 addresses is allowed").
  const all = [...emitters.keys()] as Address[];
  const logs = [];
  for (let i = 0; i < all.length; i += maxAddresses) {
    logs.push(
      ...(await client.getLogs({
        address: all.slice(i, i + maxAddresses),
        events: CHANGE_EVENTS,
        fromBlock,
        toBlock,
        strict: true,
      })),
    );
  }
  const out: ScannedEvent[] = [];
  for (const log of logs) {
    const contracts = emitters.get(log.address.toLowerCase()) ?? [];
    const common = { block: log.blockNumber, logIndex: log.logIndex, txHash: log.transactionHash, contracts };
    switch (log.eventName) {
      case "Upgraded":
        out.push({ ...common, field: "implementation", newValue: log.args.implementation.toLowerCase() });
        break;
      case "AdminChanged":
        out.push({ ...common, field: "admin", newValue: log.args.newAdmin.toLowerCase() });
        break;
      case "BeaconUpgraded":
        out.push({ ...common, field: "beacon", newValue: log.args.beacon.toLowerCase() });
        break;
      case "DiamondCut":
        out.push({ ...common, field: "facets", newValue: null });
        break;
      case "ChangedMasterCopy":
        out.push({ ...common, field: "implementation", newValue: log.args.masterCopy.toLowerCase() });
        break;
    }
  }
  out.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  return out;
}
