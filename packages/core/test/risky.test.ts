import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi, zeroAddress } from "viem";
import { riskyCalldataFlags } from "../src/risky.ts";

const IMPL = "0x1F31ab6fE4C931Ab7413523f75D490E1e0b63B4B";
const PROXY = "0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5";
const abi = parseAbi([
  "function upgradeToAndCall(address,bytes)",
  "function upgradeAndCall(address,address,bytes)",
  "function changeMasterCopy(address)",
  "function transfer(address,uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)",
]);
const safeTx = (data: `0x${string}`, operation: number) =>
  encodeFunctionData({ abi, functionName: "execTransaction", args: [PROXY, 0n, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, "0x"] });

test("UUPS upgradeToAndCall is flagged", () => {
  const f = riskyCalldataFlags(encodeFunctionData({ abi, functionName: "upgradeToAndCall", args: [IMPL, "0x"] }));
  assert.equal(f.length, 1);
  assert.match(f[0]!.title, /upgradeToAndCall/);
});

test("ProxyAdmin upgradeAndCall (OZ v5) is flagged", () => {
  const f = riskyCalldataFlags(encodeFunctionData({ abi, functionName: "upgradeAndCall", args: [PROXY, IMPL, "0x"] }));
  assert.equal(f[0]!.id, "upgrade:upgradeAndCall(address,address,bytes)");
});

test("changeMasterCopy is flagged", () => {
  const f = riskyCalldataFlags(encodeFunctionData({ abi, functionName: "changeMasterCopy", args: [IMPL] }));
  assert.match(f[0]!.detail, /singleton/);
});

test("Safe execTransaction with operation=1 is flagged as delegatecall; operation=0 is not", () => {
  const transfer = encodeFunctionData({ abi, functionName: "transfer", args: [IMPL, 1n] });
  assert.deepEqual(riskyCalldataFlags(safeTx(transfer, 0)), []);
  const f = riskyCalldataFlags(safeTx(transfer, 1));
  assert.equal(f.length, 1);
  assert.equal(f[0]!.id, "safe:delegatecall");
});

test("an upgrade wrapped in a Safe transaction is flagged", () => {
  const inner = encodeFunctionData({ abi, functionName: "upgradeToAndCall", args: [IMPL, "0x"] });
  const f = riskyCalldataFlags(safeTx(inner, 0));
  assert.equal(f.length, 1);
  assert.match(f[0]!.detail, /Inside this Safe transaction/);
});

test("ordinary calls and empty data are not flagged", () => {
  assert.deepEqual(riskyCalldataFlags(encodeFunctionData({ abi, functionName: "transfer", args: [IMPL, 5n] })), []);
  assert.deepEqual(riskyCalldataFlags("0x"), []);
});
