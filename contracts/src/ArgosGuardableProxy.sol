// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @title ArgosGuardableProxy: a transparent proxy that reports its own implementation.
/// @notice CONTROLLED DEMO. An OpenZeppelin TransparentUpgradeableProxy whose fallback answers
///         `argosImplementation()` with the EIP-1967 implementation slot, for any caller.
///         The answer comes from the proxy's own code, which upgrades can't change, so the
///         implementation behind it can't misreport itself. (A getter inside the implementation
///         could be made to lie by the next upgrade.) Contracts can't read another contract's
///         storage slots, so this is what lets an on-chain guard check the implementation.
///         Registry proxies don't have this getter; it's only for our Sepolia demo.
/// @dev The selector shadows any `argosImplementation()` in the implementation.
contract ArgosGuardableProxy is TransparentUpgradeableProxy {
    bytes4 internal constant ARGOS_IMPLEMENTATION = bytes4(keccak256("argosImplementation()"));

    constructor(address implementation, address initialOwner, bytes memory data)
        payable
        TransparentUpgradeableProxy(implementation, initialOwner, data)
    {}

    function _fallback() internal virtual override {
        if (msg.sig == ARGOS_IMPLEMENTATION && msg.data.length == 4) {
            address impl = _implementation();
            assembly {
                mstore(0, impl)
                return(0, 32)
            }
        }
        super._fallback();
    }
}
