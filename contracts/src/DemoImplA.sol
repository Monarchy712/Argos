// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title DemoImplA — first implementation behind the Argos demo proxy.
/// @notice Deliberately trivial: the point of the demo is detecting that the code behind a
///         proxy changed, not what the code does. `version()` lets anyone confirm by a call
///         which implementation is live.
contract DemoImplA {
    uint256 public counter;
    bool public initialized;

    /// @notice One-shot initializer. OZ 5.6 proxies refuse empty init data, so the demo proxy
    ///         is deployed with a call to this.
    function initialize(uint256 start) external {
        require(!initialized, "initialized");
        initialized = true;
        counter = start;
    }

    function version() external pure virtual returns (string memory) {
        return "A";
    }

    function increment() external {
        counter += 1;
    }
}
