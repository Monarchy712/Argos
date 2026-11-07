import { encodeAbiParameters, keccak256, zeroAddress, zeroHash, type Address, type Hex } from "viem";

/**
 * How a monitored contract decides which code runs.
 * - eip1967:    transparent or UUPS proxy (implementation + admin slots)
 * - zeppelinos: pre-EIP-1967 OpenZeppelin AdminUpgradeabilityProxy (keccak256(label), no -1).
 *               Same `Upgraded(address)` event, so it is watched exactly like eip1967.
 * - beacon:     EIP-1967 beacon proxy (beacon slot, then beacon.implementation())
 * - diamond:    EIP-2535 (loupe facets())
 * - safe:       Safe proxy (singleton in slot 0)
 * - none:       not a proxy, or an immutable EIP-1167 clone; we track its own codehash
 */
export const PROXY_KINDS = ["eip1967", "zeppelinos", "beacon", "diamond", "safe", "none"] as const;
export type ProxyKind = (typeof PROXY_KINDS)[number];

/** Everything that decides what code runs at an address. Equal identities = same code path. */
export interface CodeIdentity {
  proxyKind: ProxyKind;
  implementation: Address;
  implementationCodehash: Hex;
  admin: Address;
  beacon: Address;
  facetsHash: Hex;
}

/** The fields a change can be reported on (dg_latest_change.field). */
export const CHANGE_FIELDS = ["implementation", "admin", "beacon", "facets", "codehash"] as const;
export type ChangeField = (typeof CHANGE_FIELDS)[number];

export function emptyIdentity(proxyKind: ProxyKind): CodeIdentity {
  return {
    proxyKind,
    implementation: zeroAddress,
    implementationCodehash: zeroHash,
    admin: zeroAddress,
    beacon: zeroAddress,
    facetsHash: zeroHash,
  };
}

/** Single hash over all identity fields; stored as `code_identity` and compared for equality. */
export function codeIdentityHash(id: CodeIdentity): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "address" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
      ],
      [id.proxyKind, id.implementation, id.implementationCodehash, id.admin, id.beacon, id.facetsHash],
    ),
  );
}

/** Value of one change field, lowercased, for change records and comparisons. */
export function fieldValue(id: CodeIdentity, field: ChangeField): string {
  switch (field) {
    case "implementation":
      return id.implementation.toLowerCase();
    case "admin":
      return id.admin.toLowerCase();
    case "beacon":
      return id.beacon.toLowerCase();
    case "facets":
      return id.facetsHash.toLowerCase();
    case "codehash":
      return id.implementationCodehash.toLowerCase();
  }
}

/** Fields whose values differ between two identities. */
export function diffIdentity(a: CodeIdentity, b: CodeIdentity): ChangeField[] {
  return CHANGE_FIELDS.filter((f) => fieldValue(a, f) !== fieldValue(b, f));
}
