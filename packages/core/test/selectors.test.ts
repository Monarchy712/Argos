import { test } from "node:test";
import assert from "node:assert/strict";
import { toFunctionSelector } from "viem";
import { diffSelectors, sameSurface, selectorsFromBytecode, type Selector } from "../src/selectors.ts";

/** Build bytecode containing the given PUSH4s, with filler so they aren't adjacent. */
const push4s = (...sels: string[]) => ("0x" + sels.map((s) => `63${s.replace(/^0x/, "")}5b`).join("")) as `0x${string}`;

const INCREMENT = toFunctionSelector("function increment()");
const VERSION = toFunctionSelector("function version()");
const INCREMENT_BY = toFunctionSelector("function incrementBy(uint256)");

test("selectors are recovered from PUSH4 operands, deduplicated and sorted", () => {
  const got = selectorsFromBytecode(push4s(INCREMENT, VERSION, INCREMENT));
  assert.deepEqual(got, [INCREMENT, VERSION].sort());
});

test("bytes inside a larger PUSH payload are not read as opcodes", () => {
  // PUSH32 whose 32-byte operand contains 0x63 followed by what would look like a selector.
  const payload = "63deadbeef" + "00".repeat(27);
  assert.equal(payload.length / 2, 32);
  assert.deepEqual(selectorsFromBytecode(`0x7f${payload}`), []);
});

test("a truncated PUSH4 at the very end of the code is ignored", () => {
  assert.deepEqual(selectorsFromBytecode("0x63aabb"), []);
});

test("empty, odd-length and non-hex input yield no selectors rather than throwing", () => {
  for (const input of ["0x", "", "0xabc", "0xzz", "nonsense"]) {
    assert.deepEqual(selectorsFromBytecode(input), [], `input ${JSON.stringify(input)}`);
  }
});

test("input without the 0x prefix is accepted", () => {
  assert.deepEqual(selectorsFromBytecode(push4s(VERSION).slice(2)), [VERSION]);
});

test("diff reports added, removed and kept", () => {
  const d = diffSelectors([INCREMENT, VERSION], [INCREMENT, INCREMENT_BY]);
  assert.deepEqual(d.added, [INCREMENT_BY]);
  assert.deepEqual(d.removed, [VERSION]);
  assert.deepEqual(d.kept, [INCREMENT]);
});

test("diff tolerates duplicate and unsorted input", () => {
  const d = diffSelectors([VERSION, INCREMENT, VERSION], [INCREMENT, INCREMENT]);
  assert.deepEqual(d.removed, [VERSION]);
  assert.deepEqual(d.kept, [INCREMENT]);
  assert.deepEqual(d.added, []);
});

test("sameSurface is true only when nothing was added or removed", () => {
  // The clear-signing case that matters: identical call surface, different code.
  assert.equal(sameSurface(diffSelectors([INCREMENT, VERSION], [VERSION, INCREMENT])), true);
  assert.equal(sameSurface(diffSelectors([INCREMENT], [INCREMENT, INCREMENT_BY])), false);
  assert.equal(sameSurface(diffSelectors([INCREMENT, VERSION], [INCREMENT])), false);
});

test("sameSurface on two empty sets is true (and callers must not read that as 'no change')", () => {
  const d = diffSelectors([], []);
  assert.equal(sameSurface(d), true);
  assert.deepEqual(d.kept, [] as Selector[]);
});
