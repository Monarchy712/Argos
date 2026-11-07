/**
 * The recovery and retention logic that can be tested without a network: the 24-hour policy, the
 * gap arithmetic, attribute decoding, and the completeness of the renewal plan.
 *
 * The parts that need a live chain — reconstructing a genuinely expired entity — are exercised by
 * `npm run recover -w watcher -- --self-test`, which creates a throwaway entity, waits for it to
 * expire, proves it is unqueryable, and then rebuilds it from historical blocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, stringToBytes, toHex } from "viem";
import {
  BaselineSchema, ChangeNoteSchema, CurrentStateSchema, DeploymentSchema, DescriptorSchema,
  EXPIRY, LatestChangeSchema, RecoverySchema, WatcherHealthSchema,
} from "@driftguard/core";
import { classifyDowntime, gapBlocks, NORMAL_RECOVERY_SECONDS } from "../src/health.ts";
import { RENEWAL_PLAN, renewalFailed, type RenewalSummary } from "../src/renewAll.ts";
import { decodeValue, decodeAttributes, payloadHash, INDEXED_FLAG, SCHEMA_ATTRIBUTE } from "../src/recover.ts";
import { emptyCursor, type CursorFile } from "../src/cursor.ts";

const NOW = 1_700_000_000_000;
const cursorAt = (secondsAgo: number): CursorFile => ({
  ...emptyCursor(),
  chains: { "1": "1000", "11155111": "2000" },
  lastCycleAt: NOW - secondsAgo * 1000,
});

/* ------------------------------------------------- the 24-hour recovery policy (Part 4A/4B) */

test("a short gap is normal: just the poll interval", () => {
  const d = classifyDowntime(cursorAt(90), NOW);
  assert.equal(d.mode, "normal");
  assert.equal(d.seconds, 90);
});

test("a gap of minutes is 'recovering', and says the missed range is replayed", () => {
  const d = classifyDowntime(cursorAt(40 * 60), NOW);
  assert.equal(d.mode, "recovering");
  assert.match(d.detail, /Replaying change events from the checkpoint/);
  // The promise that matters: not "restarted from head", which would skip the gap silently.
  assert.doesNotMatch(d.detail, /latest block/);
});

test("the 24-hour line is where 'recovering' becomes 'disaster'", () => {
  assert.equal(classifyDowntime(cursorAt(NORMAL_RECOVERY_SECONDS - 60), NOW).mode, "recovering");
  assert.equal(classifyDowntime(cursorAt(NORMAL_RECOVERY_SECONDS + 60), NOW).mode, "disaster");
  assert.equal(NORMAL_RECOVERY_SECONDS, 24 * 3600);
});

test("a disaster gap names the two things an operator has to run", () => {
  const d = classifyDowntime(cursorAt(30 * 3600), NOW);
  assert.equal(d.mode, "disaster");
  assert.match(d.detail, /renew -w watcher/);
  assert.match(d.detail, /recover -w watcher/);
});

test("downtime is measured from the last cycle, not from process uptime", () => {
  // Two runs of the same process length classify differently if their checkpoints differ, which
  // is the whole point of persisting lastCycleAt.
  assert.equal(classifyDowntime(cursorAt(60), NOW).mode, "normal");
  assert.equal(classifyDowntime(cursorAt(100 * 3600), NOW).mode, "disaster");
});

test("a cursor with no timestamp is not reported as a disaster", () => {
  // Written by an older build. Unknown is not the same as "gone for a month".
  const d = classifyDowntime({ ...emptyCursor(), chains: { "1": "1000" } }, NOW);
  assert.equal(d.mode, "normal");
  assert.match(d.detail, /older build/);
});

test("a first run says so rather than claiming a checkpoint", () => {
  const d = classifyDowntime(emptyCursor(), NOW);
  assert.equal(d.mode, "normal");
  assert.match(d.detail, /First run/);
});

test("gapBlocks measures the replay range, and is zero when caught up", () => {
  assert.equal(gapBlocks(1000n, 1500n), 500n);
  assert.equal(gapBlocks(1500n, 1500n), 0n);
  assert.equal(gapBlocks(1600n, 1500n), 0n); // ahead of head: nothing to replay
  assert.equal(gapBlocks(undefined, 1500n), 0n);
});

/* ------------------------------------------------------- retention policy (Part 4C) */

test("retention is the installed SDK's maximum, not one month", () => {
  // MAX_LIFETIME = 7,884,000 blocks at 2 s/block (sdk/src/consts.ts).
  assert.equal(EXPIRY.maxSeconds, 7_884_000 * 2);
  assert.ok(EXPIRY.maxSeconds / 86400 > 180, "the window should be about 182 days");
});

test("the renewal threshold leaves room to notice a failure before anything expires", () => {
  assert.ok(EXPIRY.renewBelowSeconds < EXPIRY.maxSeconds / 2, "renewal must start well before expiry");
  assert.ok(EXPIRY.renewBelowSeconds / 86400 >= 30, "at least a month of head-room");
});

test("monitoring freshness is a separate, much shorter line than expiry", () => {
  // The distinction the old design collapsed: a record can be long-lived and still too old to
  // rely on. Freshness decides the status; expiry decides whether the row can be read at all.
  assert.equal(EXPIRY.freshnessSeconds, 300);
  assert.ok(EXPIRY.freshnessSeconds < EXPIRY.maxSeconds);
});

test("the renewal plan covers every Argos entity class", () => {
  // A class missing here is a class that silently expires. Compared against the schemas
  // themselves so adding a schema without a renewal policy fails this test.
  const ALL = [
    BaselineSchema, DescriptorSchema, DeploymentSchema, ChangeNoteSchema, RecoverySchema,
    LatestChangeSchema, CurrentStateSchema, WatcherHealthSchema,
  ].map((s) => s.name);
  const planned = RENEWAL_PLAN.flatMap((p) => p.schemas.map((s) => s.name));
  for (const name of ALL) assert.ok(planned.includes(name!), `${name} has no renewal policy`);
  assert.equal(new Set(planned).size, planned.length, "a schema is listed twice");
});

test("each class is renewed by the wallet that owns it", () => {
  const writer = RENEWAL_PLAN.find((p) => p.role === "writer")!.schemas.map((s) => s.name);
  const watcher = RENEWAL_PLAN.find((p) => p.role === "watcher")!.schemas.map((s) => s.name);
  // Watcher-written rows cannot be extended by the writer key, and vice versa.
  assert.ok(watcher.includes("dg_current_state"));
  assert.ok(watcher.includes("dg_latest_change"));
  assert.ok(watcher.includes("dg_watcher_health"));
  assert.ok(writer.includes("dg_baseline"));
  assert.ok(writer.includes("dg_change_note"));
  assert.equal(writer.filter((n) => watcher.includes(n)).length, 0);
});

test("every renewal entry explains why that class needs to survive", () => {
  for (const p of RENEWAL_PLAN) for (const s of p.schemas) assert.ok(s.why.length > 15, `${s.name} needs a reason`);
});

/* ---------------------------------------------- renewal failure detection (Part 4C) */

const summary = (o: Partial<RenewalSummary>): RenewalSummary =>
  ({ checked: 1, due: 0, extended: 0, failures: [], byClass: {}, ...o });

test("a clean sweep is not a failure", () => {
  assert.equal(renewalFailed(summary({ due: 0, extended: 0 })), false);
  assert.equal(renewalFailed(summary({ due: 5, extended: 5 })), false);
});

test("an extension that did not happen IS a failure", () => {
  // The silent-expiry path: rows were due and fewer came back extended.
  assert.equal(renewalFailed(summary({ due: 5, extended: 3 })), true);
  assert.equal(renewalFailed(summary({ due: 5, extended: 0 })), true);
});

test("a listed failure is a failure even when nothing was due", () => {
  assert.equal(renewalFailed(summary({ due: 0, failures: [{ schema: "dg_baseline", error: "key missing" }] })), true);
});

/* ------------------------------------- historical attribute decoding (Part 4B) */

const word = (hex: string) => `0x${hex.padStart(64, "0")}` as const;

test("each wire type decodes to the value the SDK would have written", () => {
  assert.equal(decodeValue("bool", word("01")), true);
  assert.equal(decodeValue("bool", word("00")), false);
  assert.equal(decodeValue("u64", word("2a")), 42n);
  assert.equal(decodeValue("u256", word("ff")), 255n);
  assert.equal(decodeValue("addr", word("00000000000000000000000000000000000000aa")), "0x00000000000000000000000000000000000000AA");
  assert.equal(decodeValue("i32", word("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")), -1n);
  assert.equal(decodeValue("str", toHex("dg_baseline")), "dg_baseline");
});

test("a malformed word is rejected rather than truncated", () => {
  assert.throws(() => decodeValue("u64", "0x2a"), /must be 32 bytes/);
  assert.throws(() => decodeValue("bool", word("02")), /exactly 0 or 1/);
  assert.throws(() => decodeValue("nonsense", word("01")), /unknown attribute type/);
});

test("an attribute's name and indexed flag come back from the wire triple", () => {
  const attrs = decodeAttributes([
    { name: toHex("chain_id", { size: 32 }), typeId: 3 | INDEXED_FLAG, value: word("01") },
    { name: toHex("swarm_ref", { size: 32 }), typeId: 8, value: toHex("abc") },
  ]);
  assert.deepEqual(attrs.map((a) => a.name), ["chain_id", "swarm_ref"]);
  assert.deepEqual(attrs.map((a) => a.indexed), [true, false]);
  assert.deepEqual(attrs.map((a) => a.value), [1n, "abc"]);
  // The name is null-padded on the wire and must not come back with the padding.
  assert.equal(attrs[0]!.name.length, "chain_id".length);
});

test("a tombstone is not decoded as an attribute", () => {
  // typeId 0 with an empty value means "unset this name"; the patch replay removes it instead.
  const attrs = decodeAttributes([
    { name: toHex("keep", { size: 32 }), typeId: 8, value: toHex("yes") },
    { name: toHex("drop", { size: 32 }), typeId: 0, value: "0x" },
  ]);
  assert.deepEqual(attrs.map((a) => a.name), ["keep"]);
});

test("an unknown wire type is refused, not guessed", () => {
  assert.throws(() => decodeAttributes([{ name: toHex("x", { size: 32 }), typeId: 99, value: word("01") }]), /unknown wire typeId/);
});

test("the payload hash is order-independent and changes with any value", () => {
  const a = [
    { name: "b", type: "u64", indexed: false, value: 1n, raw: word("01") },
    { name: "a", type: "str", indexed: true, value: "x", raw: toHex("x") },
  ];
  const reordered = [a[1]!, a[0]!];
  assert.equal(payloadHash(a), payloadHash(reordered));
  const changed = [{ ...a[0]!, raw: word("02") }, a[1]!];
  assert.notEqual(payloadHash(a), payloadHash(changed));
  // It is a plain keccak over a canonical rendering, so a reader can recompute it.
  assert.match(payloadHash(a), /^0x[0-9a-f]{64}$/);
});

test("the schema tag is a known attribute name, so a reconstruction can identify its schema", () => {
  assert.equal(SCHEMA_ATTRIBUTE, "arkiv.schema");
  const attrs = decodeAttributes([{ name: toHex(SCHEMA_ATTRIBUTE, { size: 32 }), typeId: 8 | INDEXED_FLAG, value: toHex("dg_baseline") }]);
  assert.equal(attrs[0]!.value, "dg_baseline");
});

test("payloadHash is keccak over the canonical form, not over an object", () => {
  const one = [{ name: "a", type: "str", indexed: false, value: "x", raw: toHex("x") }];
  assert.equal(payloadHash(one), keccak256(stringToBytes(`a:str:${toHex("x")}`)));
});
