// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ITransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ArgosGuardableProxy} from "../src/ArgosGuardableProxy.sol";
import {ArgosGuard, IArgosGuardable} from "../src/ArgosGuard.sol";
import {DemoImplA} from "../src/DemoImplA.sol";
import {DemoImplB} from "../src/DemoImplB.sol";

/// Answers `argosImplementation()` with whatever it is told, and can upgrade a real proxy when
/// called. Used to prove the guard cannot be talked out of its guarantee.
contract LyingProxy {
    address public fake;
    uint256 public timesCalled;

    constructor(address fake_) {
        fake = fake_;
    }

    function argosImplementation() external returns (address) {
        timesCalled++; // state write: proves the guard's STATICCALL cannot be used to mutate state
        return fake;
    }

    fallback() external payable {}
}

/// Lies about its implementation, but as a proper `view` function so the STATICCALL succeeds.
contract ViewLyingProxy {
    address public fake;

    constructor(address fake_) {
        fake = fake_;
    }

    function argosImplementation() external view returns (address) {
        return fake;
    }

    fallback() external payable {}
}

/// Storage-compatible with DemoImplA, but upgrades its own proxy when called. This is the only
/// real way to beat a guard that checks before the call and never looks again.
contract SelfUpgradingImpl {
    uint256 public counter;
    bool public initialized;

    /// OZ 5.6 proxies refuse empty init data, so this exists to be the constructor's call.
    function initialize(uint256 start) external {
        require(!initialized, "initialized");
        initialized = true;
        counter = start;
    }

    function upgradeMeTo(address admin, address newImpl) external {
        ProxyAdmin(admin).upgradeAndCall(ITransparentUpgradeableProxy(address(this)), newImpl, "");
    }
}

/// Returns something that is not a single clean address word.
contract MalformedProxy {
    bytes public blob;

    constructor(bytes memory blob_) {
        blob = blob_;
    }

    fallback() external payable {
        bytes memory b = blob;
        assembly {
            return(add(b, 32), mload(b))
        }
    }
}

contract ArgosGuardHardeningTest is Test {
    bytes32 constant ADMIN_SLOT = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);

    DemoImplA implA;
    DemoImplB implB;
    ArgosGuardableProxy proxy;
    ProxyAdmin admin;
    ArgosGuard guard;
    address owner = address(0xA11CE);
    address user = address(0xB0B);

    function setUp() public {
        implA = new DemoImplA();
        implB = new DemoImplB();
        proxy = new ArgosGuardableProxy(address(implA), owner, abi.encodeCall(DemoImplA.initialize, (0)));
        admin = ProxyAdmin(address(uint160(uint256(vm.load(address(proxy), ADMIN_SLOT)))));
        guard = new ArgosGuard();
    }

    function upgradeTo(address impl) internal {
        vm.prank(owner);
        admin.upgradeAndCall(ITransparentUpgradeableProxy(address(proxy)), impl, "");
    }

    // ---- requirement 6: invalid target and malformed calldata ---------------------------------

    function test_rejectsEoaTarget() public {
        address eoa = address(0xDEAD);
        assertEq(eoa.code.length, 0);
        // A staticcall to an EOA succeeds with empty returndata; that must not read as address(0).
        vm.expectRevert(abi.encodeWithSelector(ArgosGuard.UnsupportedProxy.selector, eoa));
        guard.checkAndCall(eoa, address(implA), abi.encodeCall(DemoImplA.increment, ()));
    }

    function test_rejectsZeroAddressTarget() public {
        vm.expectRevert(abi.encodeWithSelector(ArgosGuard.UnsupportedProxy.selector, address(0)));
        guard.checkAndCall(address(0), address(implA), "");
    }

    function test_rejectsZeroExpectedImplementation() public {
        // address(0) would match an unset slot, so guarding against it is meaningless.
        vm.expectRevert(ArgosGuard.InvalidExpectedImplementation.selector);
        guard.checkAndCall(address(proxy), address(0), abi.encodeCall(DemoImplA.increment, ()));
    }

    function test_rejectsShortReturnData() public {
        MalformedProxy m = new MalformedProxy(hex"1234");
        vm.expectRevert(abi.encodeWithSelector(ArgosGuard.UnsupportedProxy.selector, address(m)));
        guard.checkAndCall(address(m), address(implA), "");
    }

    function test_rejectsDirtyHighBitsInsteadOfTruncating() public {
        // A word that is not a clean address must be refused, not silently cast.
        MalformedProxy m = new MalformedProxy(abi.encode(uint256(type(uint160).max) + 1));
        vm.expectRevert(abi.encodeWithSelector(ArgosGuard.UnsupportedProxy.selector, address(m)));
        guard.checkAndCall(address(m), address(implA), "");
    }

    function test_malformedCalldataToARealProxyStillRevertsAndChangesNothing() public {
        // Garbage calldata hits the implementation's fallback; DemoImplA has none, so it reverts
        // and the guard bubbles it. The counter must be untouched.
        vm.expectRevert();
        guard.checkAndCall(address(proxy), address(implA), hex"deadbeef");
        assertEq(DemoImplA(address(proxy)).counter(), 0);
    }

    // ---- requirement 5: bypass attempts --------------------------------------------------------

    function test_cannotSubstituteADifferentTargetForTheCheck() public {
        // The guard checks and calls the SAME address, so a caller cannot have the check read one
        // contract and the call land on another. A contract that lies about its implementation
        // only ever lies about ITSELF -- it cannot borrow another proxy's good standing, and the
        // real proxy is untouched. (This is why the guarantee is "relative to the address you
        // name": pointing the guard at a hostile contract is not something it can detect.)
        ViewLyingProxy liar = new ViewLyingProxy(address(implA));
        guard.checkAndCall(address(liar), address(implA), hex"");
        assertEq(DemoImplA(address(proxy)).counter(), 0);
    }

    function test_guardCannotBeUsedToMutateStateDuringTheCheck() public {
        // argosImplementation() is read with STATICCALL, so a target that tries to write during
        // the check reverts the staticcall and is reported as unsupported.
        LyingProxy liar = new LyingProxy(address(implA));
        assertEq(liar.timesCalled(), 0);
        vm.expectRevert(abi.encodeWithSelector(ArgosGuard.UnsupportedProxy.selector, address(liar)));
        guard.checkAndCall(address(liar), address(implB), hex"");
        assertEq(liar.timesCalled(), 0, "the state write must not have happened");
    }

    function test_upgradeDuringTheGuardedCallIsCaught() public {
        // The one real way to beat a check-then-call guard: make the guarded call itself upgrade
        // the proxy, so the pre-call check was already stale by the time the call returned.
        // Set up a proxy whose implementation can upgrade it, and whose ProxyAdmin it owns.
        SelfUpgradingImpl selfUpgrading = new SelfUpgradingImpl();
        ArgosGuardableProxy p =
            new ArgosGuardableProxy(address(selfUpgrading), owner, abi.encodeCall(SelfUpgradingImpl.initialize, (0)));
        ProxyAdmin a = ProxyAdmin(address(uint160(uint256(vm.load(address(p), ADMIN_SLOT)))));
        vm.prank(owner);
        a.transferOwnership(address(p)); // the proxy becomes the admin's owner

        // Pre-call check passes: the implementation really is selfUpgrading at this point.
        (, bool matches,) = guard.wouldSucceed(address(p), address(selfUpgrading));
        assertTrue(matches);

        // The post-call re-check catches the swap and reverts the whole transaction.
        vm.expectRevert(
            abi.encodeWithSelector(
                ArgosGuard.ImplementationChangedDuringCall.selector,
                address(p),
                address(selfUpgrading),
                address(implB)
            )
        );
        guard.checkAndCall(
            address(p),
            address(selfUpgrading),
            abi.encodeCall(SelfUpgradingImpl.upgradeMeTo, (address(a), address(implB)))
        );

        // And because the whole transaction reverted, the upgrade did not stick.
        assertEq(IArgosGuardable(address(p)).argosImplementation(), address(selfUpgrading));
    }

    // ---- requirement 8: A→B→A history ---------------------------------------------------------

    function test_aToBToA_guardPassesAgainWhenTheAddressReturns() public {
        upgradeTo(address(implB));
        upgradeTo(address(implA));
        // The guard is an address check at execution time, so A→B→A passes again. That is correct
        // for this contract and exactly why Argos keeps a STICKY ever_changed_since_baseline off
        // chain: the guard cannot tell you the proxy ever moved.
        vm.prank(user);
        guard.checkAndCall(address(proxy), address(implA), abi.encodeCall(DemoImplA.increment, ()));
        assertEq(DemoImplA(address(proxy)).counter(), 1);
    }

    function test_aToBToA_guardStillBlocksWhileAtB() public {
        upgradeTo(address(implB));
        vm.expectRevert(
            abi.encodeWithSelector(
                ArgosGuard.ImplementationChanged.selector, address(proxy), address(implA), address(implB)
            )
        );
        guard.checkAndCall(address(proxy), address(implA), abi.encodeCall(DemoImplA.increment, ()));
        upgradeTo(address(implA));
        guard.checkAndCall(address(proxy), address(implA), abi.encodeCall(DemoImplA.increment, ()));
        assertEq(DemoImplA(address(proxy)).counter(), 1);
    }

    // ---- wouldSucceed mirrors checkAndCall ------------------------------------------------------

    function test_wouldSucceedMatchesCheckAndCall() public {
        (bool supported, bool matches, address actual) = guard.wouldSucceed(address(proxy), address(implA));
        assertTrue(supported);
        assertTrue(matches);
        assertEq(actual, address(implA));

        upgradeTo(address(implB));
        (supported, matches, actual) = guard.wouldSucceed(address(proxy), address(implA));
        assertTrue(supported);
        assertFalse(matches);
        assertEq(actual, address(implB));
    }

    function test_wouldSucceedReportsUnsupportedRatherThanReverting() public {
        (bool supported, bool matches, address actual) = guard.wouldSucceed(address(implA), address(implA));
        assertFalse(supported, "a plain contract has no proxy-level getter");
        assertFalse(matches);
        assertEq(actual, address(0));
    }

    function test_wouldSucceedOnEoa() public view {
        (bool supported,,) = guard.wouldSucceed(address(0xDEAD), address(implA));
        assertFalse(supported);
    }
}
