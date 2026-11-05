// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {DemoImplA} from "../src/DemoImplA.sol";
import {DemoImplB} from "../src/DemoImplB.sol";

/// Deploys ImplA, ImplB and a TransparentUpgradeableProxy pointing at ImplA, then records the
/// addresses (and the deploy block, which becomes the watcher's baseline block) in
/// deployments/<chainId>.json.
///
/// Usage: DEPLOYER_PRIVATE_KEY=... forge script script/DeployDemo.s.sol --rpc-url <url> --broadcast
contract DeployDemo is Script {
    bytes32 constant ADMIN_SLOT = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(pk);

        vm.startBroadcast(pk);
        DemoImplA implA = new DemoImplA();
        DemoImplB implB = new DemoImplB();
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implA), owner, abi.encodeCall(DemoImplA.initialize, (0))
        );
        vm.stopBroadcast();

        address proxyAdmin = address(uint160(uint256(vm.load(address(proxy), ADMIN_SLOT))));

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "owner", owner);
        vm.serializeAddress(k, "implA", address(implA));
        vm.serializeAddress(k, "implB", address(implB));
        vm.serializeAddress(k, "proxyAdmin", proxyAdmin);
        string memory json = vm.serializeAddress(k, "proxy", address(proxy));
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));

        console2.log("proxy", address(proxy));
        console2.log("implA", address(implA));
        console2.log("implB", address(implB));
        console2.log("proxyAdmin", proxyAdmin);
    }
}
