import { keccak256, toHex, numberToHex, hexToBigInt, type Hex } from "viem";

/** EIP-1967 slot = keccak256(label) - 1, as a 32-byte hex string. Computed, never hand-typed. */
function eip1967Slot(label: string): Hex {
  return numberToHex(hexToBigInt(keccak256(toHex(label))) - 1n, { size: 32 });
}

/** https://eips.ethereum.org/EIPS/eip-1967 */
export const IMPLEMENTATION_SLOT = eip1967Slot("eip1967.proxy.implementation");
export const ADMIN_SLOT = eip1967Slot("eip1967.proxy.admin");
export const BEACON_SLOT = eip1967Slot("eip1967.proxy.beacon");
/** Safe proxies keep the singleton (master copy) address in storage slot 0. */
export const SAFE_SINGLETON_SLOT: Hex = numberToHex(0n, { size: 32 });
