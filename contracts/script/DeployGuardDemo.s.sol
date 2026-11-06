// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ArgosGuardableProxy} from "../src/ArgosGuardableProxy.sol";
import {ArgosGuard} from "../src/ArgosGuard.sol";
import {DemoImplA} from "../src/DemoImplA.sol";

/// CONTROLLED DEMO: deploys an ArgosGuardableProxy (pointing at the existing DemoImplA from
/// deployments/<chainId>.json) and an ArgosGuard, and records them in
/// deployments/<chainId>-guard.json. The video's demo proxy is not touched.
///
/// Usage: DEPLOYER_PRIVATE_KEY=... forge script script/DeployGuardDemo.s.sol --rpc-url <url> --broadcast
contract DeployGuardDemo is Script {
    bytes32 constant ADMIN_SLOT = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(pk);
        string memory base = vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        address implA = vm.parseJsonAddress(base, ".implA");
        address implB = vm.parseJsonAddress(base, ".implB");

        vm.startBroadcast(pk);
        ArgosGuardableProxy proxy = new ArgosGuardableProxy(implA, owner, abi.encodeCall(DemoImplA.initialize, (0)));
        ArgosGuard guard = new ArgosGuard();
        vm.stopBroadcast();

        address proxyAdmin = address(uint160(uint256(vm.load(address(proxy), ADMIN_SLOT))));
        string memory k = "guard";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "owner", owner);
        vm.serializeAddress(k, "implA", implA);
        vm.serializeAddress(k, "implB", implB);
        vm.serializeAddress(k, "proxyAdmin", proxyAdmin);
        vm.serializeAddress(k, "guard", address(guard));
        string memory json = vm.serializeAddress(k, "proxy", address(proxy));
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), "-guard.json"));

        console2.log("guardable proxy", address(proxy));
        console2.log("guard", address(guard));
        console2.log("proxyAdmin", proxyAdmin);
    }
}
