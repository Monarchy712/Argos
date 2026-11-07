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

/**
 * Pre-EIP-1967 OpenZeppelin `AdminUpgradeabilityProxy`: `keccak256(label)` with **no** `- 1`.
 * Still the live pattern behind some of the largest contracts on mainnet — USDC's FiatTokenProxy
 * keeps its implementation here — so a reader that only knows EIP-1967 calls them "not a proxy".
 * Verified against 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 at block 26357792, which answers
 * 0x43506849D7C04F9138D1A2050bbF3A0c054402dd (USDC v2.2).
 */
export const ZEPPELINOS_IMPLEMENTATION_SLOT = keccak256(toHex("org.zeppelinos.proxy.implementation"));
/** Pre-EIP-1967 OpenZeppelin admin slot, same `keccak256(label)` derivation. */
export const ZEPPELINOS_ADMIN_SLOT = keccak256(toHex("org.zeppelinos.proxy.admin"));

/**
 * EIP-1822 (DelegateProxy) keeps its logic address at `keccak256("PROXIABLE")`. Argos reads it
 * only as evidence that an address *is* a proxy; it is not a kind Argos monitors, because the
 * standard never settled and the slot is also used by unrelated contracts.
 * https://eips.ethereum.org/EIPS/eip-1822
 */
export const EIP1822_PROXIABLE_SLOT = keccak256(toHex("PROXIABLE"));

/**
 * EIP-1167 minimal proxy: 45 bytes of runtime code with the implementation address spliced in at
 * byte 10. The address is in the code, not in storage, so a clone can never be upgraded — which is
 * why Argos monitors one by the proxy's own codehash rather than by a slot.
 * https://eips.ethereum.org/EIPS/eip-1167
 */
const EIP1167_RUNTIME = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/;

/**
 * The implementation a canonical EIP-1167 clone delegates to, or `null` for anything else.
 *
 * Deliberately exact: only the canonical 45-byte runtime matches. Several optimised and "vanity"
 * variants exist, and guessing which 20 bytes of a near-miss are an address would be exactly the
 * kind of confident wrong answer Argos exists to avoid. A variant is reported as a proxy Argos
 * cannot read instead.
 */
export function eip1167Implementation(runtimeBytecode: string): Hex | null {
  const m = EIP1167_RUNTIME.exec(runtimeBytecode.toLowerCase());
  return m ? (`0x${m[1]}` as Hex) : null;
}
