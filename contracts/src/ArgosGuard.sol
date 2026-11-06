// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IArgosGuardable {
    function argosImplementation() external view returns (address);
}

/// @title ArgosGuard: check the implementation and make the call in one transaction.
/// @notice CONTROLLED DEMO, for proxies that expose a trustworthy `argosImplementation()`
///         (see ArgosGuardableProxy). `checkAndCall` reverts unless the proxy's implementation
///         is the one the caller expects (e.g. the baseline Argos published on Arkiv), and
///         otherwise forwards the call. Because both happen in the same transaction, an upgrade
///         can't land between the check and the call.
///         Limits: the target sees this contract as msg.sender, not the user, so it only suits
///         calls that don't depend on the sender. A real wallet would do the same check in the
///         user's own account (e.g. a batched call from a smart account). Not deployed for any
///         registry contract.
contract ArgosGuard {
    error ImplementationChanged(address proxy, address expected, address actual);

    event GuardedCall(address indexed proxy, address indexed implementation, address indexed caller);

    function checkAndCall(address proxy, address expectedImplementation, bytes calldata data)
        external
        payable
        returns (bytes memory result)
    {
        address actual = IArgosGuardable(proxy).argosImplementation();
        if (actual != expectedImplementation) revert ImplementationChanged(proxy, expectedImplementation, actual);
        bool ok;
        (ok, result) = proxy.call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        emit GuardedCall(proxy, actual, msg.sender);
    }
}
