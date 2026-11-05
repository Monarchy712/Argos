import { test } from "node:test";
import assert from "node:assert/strict";
import { codeIdentityHash, emptyIdentity, type CodeIdentity } from "@driftguard/core";
import { step } from "../src/engine.ts";
import type { Baseline, ObservedEvent } from "../src/types.ts";

const PROXY = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const A = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const B = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const HASH_A = "0x" + "aa".repeat(32);
const HASH_B = "0x" + "bb".repeat(32);

const idA: CodeIdentity = { ...emptyIdentity("eip1967"), implementation: A, implementationCodehash: HASH_A as `0x${string}` };
const idB: CodeIdentity = { ...idA, implementation: B, implementationCodehash: HASH_B as `0x${string}` };

const baseline: Baseline = {
  key: "b1",
  chainId: 31337,
  address: PROXY,
  identity: idA,
  identityHash: codeIdentityHash(idA),
  block: 10n,
  baselinedAt: 0,
  descriptorHash: "",
  swarmRef: "",
  reason: "",
  previousKey: "",
};

const upgraded = (to: string, block: bigint): ObservedEvent => ({
  field: "implementation",
  newValue: to.toLowerCase(),
  block,
  logIndex: 0,
  txHash: `0x${block.toString(16).padStart(64, "0")}`,
});

const base = { chainId: 31337, address: PROXY, baseline, now: 1000 } as const;

test("no change: matches baseline, nothing recorded", () => {
  const out = step({ ...base, cursor: null, events: [], observed: idA, block: 11n });
  assert.equal(out.matchesBaseline, true);
  assert.equal(out.cursor.everChanged, false);
  assert.deepEqual(out.changes, []);
});

test("A→B detected by event, codehash change is not double-reported", () => {
  const out = step({ ...base, cursor: null, events: [upgraded(B, 12n)], observed: idB, block: 12n });
  assert.equal(out.matchesBaseline, false);
  assert.equal(out.cursor.everChanged, true);
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0]!.detectedBy, "event");
  assert.equal(out.changes[0]!.previousValue, A.toLowerCase());
  assert.equal(out.changes[0]!.newValue, B.toLowerCase());
});

test("A→B→A inside one cycle: slot read looks unchanged, events still flip ever_changed", () => {
  const out = step({ ...base, cursor: null, events: [upgraded(B, 12n), upgraded(A, 13n)], observed: idA, block: 13n });
  assert.equal(out.matchesBaseline, true);
  assert.equal(out.cursor.everChanged, true);
  assert.equal(out.changes.length, 2);
  assert.equal(out.changes.at(-1)!.newValue, A.toLowerCase());
});

test("A→B then B→A in a later cycle: ever_changed stays true", () => {
  const c1 = step({ ...base, cursor: null, events: [upgraded(B, 12n)], observed: idB, block: 12n });
  const c2 = step({ ...base, cursor: c1.cursor, events: [upgraded(A, 20n)], observed: idA, block: 20n });
  assert.equal(c2.matchesBaseline, true);
  assert.equal(c2.cursor.everChanged, true);
  const c3 = step({ ...base, cursor: c2.cursor, events: [], observed: idA, block: 30n });
  assert.equal(c3.cursor.everChanged, true, "never auto-resets");
  assert.deepEqual(c3.changes, []);
});

test("change without an event is detected by the slot read", () => {
  const out = step({ ...base, cursor: null, events: [], observed: idB, block: 15n });
  assert.equal(out.changes.length, 1); // implementation only; the codehash change is implied
  assert.equal(out.changes[0]!.field, "implementation");
  assert.ok(out.changes.every((c) => c.detectedBy === "slot" && c.txHash === ""));
  assert.equal(out.cursor.everChanged, true);
});

test("a rebaseline (new baseline key) resets ever_changed", () => {
  const c1 = step({ ...base, cursor: null, events: [upgraded(B, 12n)], observed: idB, block: 12n });
  const rebased: Baseline = { ...baseline, key: "b2", identity: idB, identityHash: codeIdentityHash(idB) };
  const c2 = step({ ...base, baseline: rebased, cursor: c1.cursor, events: [], observed: idB, block: 40n });
  assert.equal(c2.matchesBaseline, true);
  assert.equal(c2.cursor.everChanged, false);
});

test("upgrade to the same implementation is not a change", () => {
  const out = step({ ...base, cursor: null, events: [upgraded(A, 12n)], observed: idA, block: 12n });
  assert.deepEqual(out.changes, []);
  assert.equal(out.cursor.everChanged, false);
});

test("same implementation address but new code (metamorphic redeploy) is a codehash change", () => {
  const redeployed: CodeIdentity = { ...idA, implementationCodehash: HASH_B as `0x${string}` };
  const out = step({ ...base, cursor: null, events: [], observed: redeployed, block: 16n });
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0]!.field, "codehash");
  assert.equal(out.matchesBaseline, false);
});
