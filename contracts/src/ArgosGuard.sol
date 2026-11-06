// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IArgosGuardable {
    function argosImplementation() external view returns (address);
}

/// @title ArgosGuard: check the implementation and make the call in one transaction.
/// @notice CONTROLLED DEMO. Closes the TOCTOU window between Argos showing you a verified
///         implementation and your transaction actually running: a proxy can be upgraded in
///         between, and an off-chain check cannot prevent that. `checkAndCall` reverts unless the
///         proxy's implementation is the one the caller expects (e.g. the baseline Argos
///         published on Arkiv), and otherwise forwards the call. Both happen in one transaction,
///         so no upgrade can land between them.
///
/// @dev WHAT THIS DOES NOT COVER, stated plainly:
///  - **Only proxies with a proxy-level getter.** An external contract cannot SLOAD another
///    contract's EIP-1967 slot, so the target must answer `argosImplementation()` from code the
///    proxy itself owns (see ArgosGuardableProxy). A getter living in the *implementation* is not
///    good enough: the very upgrade you are guarding against could make it lie. No contract in
///    the ERC-7730 registry exposes such a getter, so this protects our demo proxy and nothing
///    else. Calls to a target without the getter revert with `UnsupportedProxy`.
///  - **msg.sender becomes this contract.** The target sees the guard, not the user, so this only
///    suits calls that do not depend on the sender. The general fix is the same check inside the
///    user's own account — a batched call from a smart account (ERC-4337 / EIP-7702) — not a
///    shared guard contract.
///  - **It guards the implementation address, not behaviour.** An unchanged address means the
///    same code path, not that the call is safe. Argos does not decide that.
contract ArgosGuard {
    /// @notice The proxy's implementation is not what the caller expected. Nothing was called.
    error ImplementationChanged(address proxy, address expected, address actual);
    /// @notice The target has no code, or no trustworthy `argosImplementation()`. Nothing was called.
    error UnsupportedProxy(address proxy);
    /// @notice Refused rather than guard against address(0), which would match an empty slot.
    error InvalidExpectedImplementation();
    /// @notice The implementation changed *during* the protected call (re-entrant upgrade).
    error ImplementationChangedDuringCall(address proxy, address expected, address actual);

    event GuardedCall(address indexed proxy, address indexed implementation, address indexed caller);

    /// @param proxy The proxy to check and call. The check and the call target the SAME address,
    ///        so a different target cannot be substituted for one of the two.
    /// @param expectedImplementation The implementation the caller was shown. Must be non-zero.
    /// @param data Calldata forwarded verbatim to `proxy` if, and only if, the check passes.
    function checkAndCall(address proxy, address expectedImplementation, bytes calldata data)
        external
        payable
        returns (bytes memory result)
    {
        if (expectedImplementation == address(0)) revert InvalidExpectedImplementation();

        address actual = _implementationOf(proxy);
        if (actual != expectedImplementation) revert ImplementationChanged(proxy, expectedImplementation, actual);

        bool ok;
        (ok, result) = proxy.call{value: msg.value}(data);
        if (!ok) {
            // Bubble the target's own revert data so the caller sees the real reason.
            assembly {
                revert(add(result, 32), mload(result))
            }
        }

        // Re-check after the call. `data` is arbitrary and may re-enter; without this, a call that
        // upgraded the proxy mid-execution would have passed a check that was already stale.
        address afterCall = _implementationOf(proxy);
        if (afterCall != expectedImplementation) {
            revert ImplementationChangedDuringCall(proxy, expectedImplementation, afterCall);
        }

        emit GuardedCall(proxy, actual, msg.sender);
    }

    /// @dev STATICCALL, so reading the implementation can never mutate state. Reverts with a typed
    ///      error for a target that has no code or does not answer with exactly one word — an EOA
    ///      staticcall "succeeds" with empty returndata, which must not be read as address(0).
    function _implementationOf(address proxy) internal view returns (address) {
        if (proxy.code.length == 0) revert UnsupportedProxy(proxy);
        (bool ok, bytes memory ret) =
            proxy.staticcall(abi.encodeWithSelector(IArgosGuardable.argosImplementation.selector));
        if (!ok || ret.length != 32) revert UnsupportedProxy(proxy);
        uint256 word = abi.decode(ret, (uint256));
        // Reject dirty high bits rather than silently truncating to an address.
        if (word > type(uint160).max) revert UnsupportedProxy(proxy);
        return address(uint160(word));
    }

    /// @notice Read-only preflight for a UI: what the guard would do right now, without sending.
    /// @dev Mirrors the same checks `checkAndCall` makes, so the UI cannot drift from the contract.
    ///      Still only a preview: between this call and a transaction, the implementation can
    ///      change. That is the entire reason `checkAndCall` re-checks on chain.
    function wouldSucceed(address proxy, address expectedImplementation)
        external
        view
        returns (bool supported, bool matches, address actual)
    {
        if (proxy.code.length == 0) return (false, false, address(0));
        (bool ok, bytes memory ret) =
            proxy.staticcall(abi.encodeWithSelector(IArgosGuardable.argosImplementation.selector));
        if (!ok || ret.length != 32) return (false, false, address(0));
        uint256 word = abi.decode(ret, (uint256));
        if (word > type(uint160).max) return (false, false, address(0));
        actual = address(uint160(word));
        return (true, actual == expectedImplementation && expectedImplementation != address(0), actual);
    }
}
