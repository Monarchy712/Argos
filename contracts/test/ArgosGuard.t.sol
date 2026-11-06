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

contract ArgosGuardTest is Test {
    bytes32 constant IMPL_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
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

    function test_getterReportsTheSlot() public {
        assertEq(IArgosGuardable(address(proxy)).argosImplementation(), address(implA));
        assertEq(address(uint160(uint256(vm.load(address(proxy), IMPL_SLOT)))), address(implA));
        upgradeTo(address(implB));
        assertEq(IArgosGuardable(address(proxy)).argosImplementation(), address(implB));
    }

    function test_getterWorksForAdminToo() public {
        vm.prank(address(admin));
        assertEq(IArgosGuardable(address(proxy)).argosImplementation(), address(implA));
    }

    function test_proxyStillForwardsNormalCalls() public {
        DemoImplA(address(proxy)).increment();
        assertEq(DemoImplA(address(proxy)).counter(), 1);
        assertEq(DemoImplA(address(proxy)).version(), "A");
    }

    function test_guardedCallPassesWhenImplementationMatches() public {
        vm.prank(user);
        vm.expectEmit(true, true, true, false, address(guard));
        emit ArgosGuard.GuardedCall(address(proxy), address(implA), user);
        guard.checkAndCall(address(proxy), address(implA), abi.encodeCall(DemoImplA.increment, ()));
        assertEq(DemoImplA(address(proxy)).counter(), 1);
    }

    function test_guardedCallRevertsAfterUpgrade() public {
        upgradeTo(address(implB));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ArgosGuard.ImplementationChanged.selector, address(proxy), address(implA), address(implB)));
        guard.checkAndCall(address(proxy), address(implA), abi.encodeCall(DemoImplA.increment, ()));
        assertEq(DemoImplA(address(proxy)).counter(), 0); // nothing ran
    }

    function test_guardedCallBubblesTargetRevert() public {
        vm.expectRevert(bytes("initialized"));
        guard.checkAndCall(address(proxy), address(implA), abi.encodeCall(DemoImplA.initialize, (5)));
    }

    function test_guardRejectsProxyWithoutGetter() public {
        // A plain contract has no argosImplementation(): the guard reverts instead of calling.
        vm.expectRevert();
        guard.checkAndCall(address(implA), address(implA), abi.encodeCall(DemoImplA.increment, ()));
    }
}
