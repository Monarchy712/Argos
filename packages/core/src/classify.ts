/**
 * Classifies how a contract decides which code runs, by reading its proxy slots at one block.
 * Shared by the monitored-set selection and the importer's dg_deployment.proxy_kind.
 */
import { parseAbi, zeroAddress, type Address, type PublicClient } from "viem";
import { readAddressSlot } from "./read.ts";
import { BEACON_SLOT, IMPLEMENTATION_SLOT, SAFE_SINGLETON_SLOT } from "./slots.ts";
import type { ProxyKind } from "./identity.ts";

export type Classification = ProxyKind | "no-code";

const loupe = parseAbi(["function facets() view returns ((address facetAddress, bytes4[] functionSelectors)[])"]);
const beaconAbi = parseAbi(["function implementation() view returns (address)"]);

export async function classifyContract(
  client: PublicClient,
  address: Address,
  blockNumber: bigint,
): Promise<{ kind: Classification; implementation: Address }> {
  const code = await client.getCode({ address, blockNumber });
  if (!code || code === "0x") return { kind: "no-code", implementation: zeroAddress };
  const impl = await readAddressSlot(client, address, IMPLEMENTATION_SLOT, blockNumber);
  if (impl !== zeroAddress) return { kind: "eip1967", implementation: impl };
  const beacon = await readAddressSlot(client, address, BEACON_SLOT, blockNumber);
  if (beacon !== zeroAddress) {
    const bi = await client
      .readContract({ address: beacon, abi: beaconAbi, functionName: "implementation", blockNumber })
      .catch(() => zeroAddress);
    return { kind: "beacon", implementation: bi };
  }
  const facets = await client.readContract({ address, abi: loupe, functionName: "facets", blockNumber }).catch(() => null);
  if (facets && facets.length > 0) return { kind: "diamond", implementation: zeroAddress };
  // Safe proxy: tiny bytecode delegating to the singleton stored in slot 0.
  if ((code.length - 2) / 2 < 400) {
    const s0 = await readAddressSlot(client, address, SAFE_SINGLETON_SLOT, blockNumber);
    const s0code = s0 !== zeroAddress ? await client.getCode({ address: s0, blockNumber }) : undefined;
    if (s0code && s0code !== "0x") return { kind: "safe", implementation: s0 };
  }
  return { kind: "none", implementation: zeroAddress };
}
