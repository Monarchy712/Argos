// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ITransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

/// Points the demo proxy at ImplA or ImplB through its ProxyAdmin.
///
/// Usage: DEPLOYER_PRIVATE_KEY=... TARGET=B forge script script/UpgradeDemo.s.sol --rpc-url <url> --broadcast
/// Set DEPLOYMENT=<chainId>-guard.json to upgrade the guard demo proxy instead.
contract UpgradeDemo is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory target = vm.envString("TARGET");
        string memory file = vm.envOr("DEPLOYMENT", string.concat(vm.toString(block.chainid), ".json"));
        string memory json = vm.readFile(string.concat("./deployments/", file));

        address proxy = vm.parseJsonAddress(json, ".proxy");
        address proxyAdmin = vm.parseJsonAddress(json, ".proxyAdmin");
        address impl;
        if (keccak256(bytes(target)) == keccak256("A")) impl = vm.parseJsonAddress(json, ".implA");
        else if (keccak256(bytes(target)) == keccak256("B")) impl = vm.parseJsonAddress(json, ".implB");
        else revert("TARGET must be A or B");

        vm.startBroadcast(pk);
        ProxyAdmin(proxyAdmin).upgradeAndCall(ITransparentUpgradeableProxy(proxy), impl, "");
        vm.stopBroadcast();

        console2.log("upgraded proxy", proxy);
        console2.log("to implementation", impl);
    }
}
