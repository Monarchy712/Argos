import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, stringToBytes } from "viem";
import { computeDescriptorHash } from "@ethereum-sourcify/clear-signing";
import { dedupeDeployments, jcsHash, truncateBytes } from "../src/registry.ts";

test("JCS sorts keys and drops whitespace (RFC 8785)", () => {
  const { hash, size } = jcsHash({ b: 1, a: [1, "x", { d: true, c: null }] });
  const expected = '{"a":[1,"x",{"c":null,"d":true}],"b":1}';
  assert.equal(hash, keccak256(stringToBytes(expected)));
  assert.equal(size, expected.length);
});

test("our JCS hash equals the library's ERC-8176 hash", () => {
  const d = { $schema: "x", context: { contract: { deployments: [{ chainId: 1, address: "0x1" }] } }, display: { formats: { "f()": { intent: "Ünïcode ✓" } } }, metadata: { owner: "o" } };
  assert.equal(jcsHash(d).hash, computeDescriptorHash(d as never));
});

test("truncateBytes respects the UTF-8 byte limit", () => {
  const s = "é".repeat(100); // 200 bytes
  assert.ok(Buffer.byteLength(truncateBytes(s, 120)) <= 120);
  assert.equal(truncateBytes("short"), "short");
});

test("deployments dedupe on (chain, address, descriptor hash)", () => {
  const r = { chainId: 1, address: "0xAbC0000000000000000000000000000000000001" as const, descriptorHash: "0x01" as const, registryPath: "a", kind: "calldata" as const };
  assert.equal(dedupeDeployments([r, { ...r, address: "0xabc0000000000000000000000000000000000001" }, { ...r, descriptorHash: "0x02" }]).length, 2);
});
