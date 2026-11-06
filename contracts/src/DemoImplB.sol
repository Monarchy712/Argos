// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title DemoImplB — second implementation for the Argos demo proxy.
/// @notice Same storage layout as DemoImplA (so upgrades are layout-safe) but a different
///         `version()` and an extra function, so the bytecode and codehash differ.
contract DemoImplB {
    uint256 public counter;
    bool public initialized;

    function version() external pure returns (string memory) {
        return "B";
    }

    function increment() external {
        counter += 1;
    }

    function incrementBy(uint256 n) external {
        counter += n;
    }
}
