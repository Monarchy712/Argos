// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {TransparentUpgradeableProxy, ITransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {DemoImplA} from "../src/DemoImplA.sol";
import {DemoImplB} from "../src/DemoImplB.sol";

/// Checks the assumptions the watcher relies on: EIP-1967 slots hold the implementation and
/// admin, and upgrades emit `Upgraded(address indexed)` from the proxy address.
contract DemoProxyTest is Test {
    bytes32 constant IMPL_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
    bytes32 constant ADMIN_SLOT = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);
    bytes32 constant UPGRADED_TOPIC = keccak256("Upgraded(address)");

    DemoImplA implA;
    DemoImplB implB;
    TransparentUpgradeableProxy proxy;
    ProxyAdmin admin;
    address owner = address(0xA11CE);

    function setUp() public {
        implA = new DemoImplA();
        implB = new DemoImplB();
        proxy = new TransparentUpgradeableProxy(address(implA), owner, abi.encodeCall(DemoImplA.initialize, (7)));
        admin = ProxyAdmin(address(uint160(uint256(vm.load(address(proxy), ADMIN_SLOT)))));
    }

    function implOf() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(proxy), IMPL_SLOT))));
    }

    function test_slotsMatchOzConstants() public view {
        assertEq(IMPL_SLOT, 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc);
        assertEq(ADMIN_SLOT, 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103);
        assertEq(implOf(), address(implA));
        assertEq(admin.owner(), owner);
        assertEq(DemoImplA(address(proxy)).counter(), 7);
    }

    function test_upgradeAtoBtoA_emitsEventsAndUpdatesSlot() public {
        vm.recordLogs();
        vm.prank(owner);
        admin.upgradeAndCall(ITransparentUpgradeableProxy(address(proxy)), address(implB), "");
        assertEq(implOf(), address(implB));
        assertEq(DemoImplB(address(proxy)).version(), "B");

        vm.prank(owner);
        admin.upgradeAndCall(ITransparentUpgradeableProxy(address(proxy)), address(implA), "");
        assertEq(implOf(), address(implA));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(proxy) && logs[i].topics[0] == UPGRADED_TOPIC) seen++;
        }
        assertEq(seen, 2, "one Upgraded event per upgrade, emitted by the proxy");
    }

    function test_onlyOwnerCanUpgrade() public {
        vm.expectRevert();
        admin.upgradeAndCall(ITransparentUpgradeableProxy(address(proxy)), address(implB), "");
    }

    function test_codehashesDiffer() public view {
        assertTrue(address(implA).codehash != address(implB).codehash);
    }
}
