import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ADMIN_SLOT, BEACON_SLOT, IMPLEMENTATION_SLOT, SAFE_SINGLETON_SLOT } from "./slots.ts";
import { emptyIdentity, type CodeIdentity, type ProxyKind } from "./identity.ts";

const beaconAbi = parseAbi(["function implementation() view returns (address)"]);
const loupeAbi = parseAbi([
  "function facets() view returns ((address facetAddress, bytes4[] functionSelectors)[])",
]);

/** Reads the low 20 bytes of a storage slot as an address. */
export async function readAddressSlot(
  client: PublicClient,
  address: Address,
  slot: Hex,
  blockNumber: bigint,
): Promise<Address> {
  const raw = (await client.getStorageAt({ address, slot, blockNumber })) ?? zeroHash;
  return getAddress(`0x${raw.slice(-40)}`);
}

/** keccak256 of the deployed bytecode (zero hash when there is no code). */
export async function readCodehash(client: PublicClient, address: Address, blockNumber: bigint): Promise<Hex> {
  const code = await client.getCode({ address, blockNumber });
  return code && code !== "0x" ? keccak256(code) : zeroHash;
}

/** Order-independent hash of a diamond's facets and their selectors. */
export function facetsHash(
  facets: readonly { facetAddress: Address; functionSelectors: readonly Hex[] }[],
): Hex {
  const norm = facets
    .map((f) => ({
      facet: f.facetAddress.toLowerCase() as Address,
      selectors: [...f.functionSelectors].map((s) => s.toLowerCase() as Hex).sort(),
    }))
    .sort((a, b) => (a.facet < b.facet ? -1 : a.facet > b.facet ? 1 : 0));
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "facet", type: "address" },
            { name: "selectors", type: "bytes4[]" },
          ],
        },
      ],
      [norm],
    ),
  );
}

/**
 * Reads a contract's code identity at one block, for its declared proxy kind.
 * All reads pin `blockNumber` so the result is a consistent snapshot.
 */
export async function readIdentity(
  client: PublicClient,
  address: Address,
  kind: ProxyKind,
  blockNumber: bigint,
): Promise<CodeIdentity> {
  const id = emptyIdentity(kind);
  switch (kind) {
    case "eip1967": {
      id.implementation = await readAddressSlot(client, address, IMPLEMENTATION_SLOT, blockNumber);
      id.admin = await readAddressSlot(client, address, ADMIN_SLOT, blockNumber);
      id.implementationCodehash = await readCodehash(client, id.implementation, blockNumber);
      break;
    }
    case "beacon": {
      id.beacon = await readAddressSlot(client, address, BEACON_SLOT, blockNumber);
      id.implementation = await client.readContract({
        address: id.beacon,
        abi: beaconAbi,
        functionName: "implementation",
        blockNumber,
      });
      id.implementationCodehash = await readCodehash(client, id.implementation, blockNumber);
      break;
    }
    case "diamond": {
      const facets = await client.readContract({ address, abi: loupeAbi, functionName: "facets", blockNumber });
      id.facetsHash = facetsHash(facets);
      break;
    }
    case "safe": {
      id.implementation = await readAddressSlot(client, address, SAFE_SINGLETON_SLOT, blockNumber);
      id.implementationCodehash = await readCodehash(client, id.implementation, blockNumber);
      break;
    }
    case "none": {
      id.implementationCodehash = await readCodehash(client, address, blockNumber);
      break;
    }
  }
  return id;
}
