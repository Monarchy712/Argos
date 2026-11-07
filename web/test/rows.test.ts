/**
 * Indexing an Arkiv snapshot by contract, when a contract holds more than one row.
 *
 * The regression this guards is real. On 2026-11-06 two watcher processes ran at once and the
 * Sepolia proxy 0x319480a0… ended up with two `dg_current_state` rows: a fresh one saying the
 * implementation no longer matched its baseline, and a 4.8-hour-old one still saying it did.
 * `new Map(rows.map(...))` keeps whichever arrives last, and Arkiv pages by `$key` — a hash with
 * no relation to time — so which of the two the UI rendered was luck. It happened to pick the
 * fresh one. It could as easily have shown a stale row claiming a changed contract still matched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRows } from "../src/lib/rows.ts";
import type { ArkivSnapshot, BaselineRow, ChangeNoteRow, ChangeRow, CurrentRow } from "../src/lib/arkiv.ts";

const CHAIN = 11155111;
const ADDR = "0x319480a00314B03453d1f43b96eCc9F1C4f6EF1d" as const;
const IMPL_OLD = "0x1511e14868422510F32AA1bF91c95138DA51b295" as const;
const IMPL_NEW = "0x749e7099AebC06D0c87893E3F86bC83f05E2F1C9" as const;
const NOW = 1_793_994_500;

const baseline = (over: Partial<BaselineRow> = {}): BaselineRow => ({
  key: "0xb12d3e2dd7e8e389d7a99a2692ce125c4d6c2d5bbcd2341c1783d530b7c7ae4e",
  chainId: CHAIN, address: ADDR, proxyKind: "eip1967", implementation: IMPL_OLD,
  codeIdentity: "0xaa", descriptorHash: "", swarmRef: "", block: 12_078_000n,
  baselinedAt: NOW - 20_000, reason: "test", ...over,
});

const current = (over: Partial<CurrentRow>): CurrentRow => ({
  key: "0x01", chainId: CHAIN, address: ADDR, implementation: IMPL_OLD, codeIdentity: "0xaa",
  matchesBaseline: true, everChanged: false, checkedBlock: 12_078_708n, checkedAt: NOW - 17_000,
  detection: "event+slot", expiresAt: NOW + 15_000_000, ...over,
});

const change = (over: Partial<ChangeRow> = {}): ChangeRow => ({
  key: "0xc1", chainId: CHAIN, address: ADDR, field: "implementation",
  previousValue: IMPL_OLD, newValue: IMPL_NEW, changeBlock: 12_078_718n,
  txHash: "0x6bf3", detectedAt: NOW - 100, detectedBy: "event", ...over,
});

const note = (over: Partial<ChangeNoteRow> = {}): ChangeNoteRow => ({
  key: "0xn1", chainId: CHAIN, address: ADDR, fromImplementation: IMPL_OLD,
  toImplementation: IMPL_NEW, changeBlock: 12_078_718n, summaryHash: "0xbb",
  summarySwarmRef: "ref", selectorsAdded: 1, selectorsRemoved: 1, sameSurface: false,
  model: "gemini-2.5-flash", requestId: "req-1", provider: "0x00", costUsdMicro: 1137,
  generatedAt: NOW - 60, ...over,
});

const snap = (over: Partial<ArkivSnapshot>): ArkivSnapshot => ({
  baselines: [baseline()], current: [], changes: [], changeNotes: [],
  arkivBlock: 312_834n, readAt: NOW * 1000, ms: 1, ...over,
});

test("with two current_state rows, the newest observation is the one rendered", () => {
  // Deliberately ordered stale-last, which is what a `$key` ordering can produce and what the
  // old last-wins indexing would have taken.
  const stale = current({ key: "0x77355b4c", checkedAt: NOW - 17_000, matchesBaseline: true, implementation: IMPL_OLD });
  const fresh = current({ key: "0x93b2e4a1", checkedAt: NOW - 96, matchesBaseline: false, everChanged: true, implementation: IMPL_NEW, checkedBlock: 12_080_113n });
  const rows = buildRows(snap({ current: [fresh, stale] }), null, NOW * 1000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.current?.checkedAt, fresh.checkedAt);
  assert.equal(rows[0]!.current?.matchesBaseline, false, "the stale row still claimed a match; it must not win");
});

test("order of the two rows in the snapshot does not change the answer", () => {
  const stale = current({ key: "0x77355b4c", checkedAt: NOW - 17_000, matchesBaseline: true });
  const fresh = current({ key: "0x93b2e4a1", checkedAt: NOW - 96, matchesBaseline: false, everChanged: true });
  for (const order of [[fresh, stale], [stale, fresh]]) {
    const rows = buildRows(snap({ current: order }), null, NOW * 1000);
    assert.equal(rows[0]!.current?.checkedAt, fresh.checkedAt);
    assert.equal(rows[0]!.current?.matchesBaseline, false);
  }
});

test("a single current_state row is unaffected", () => {
  const only = current({ key: "0x01", checkedAt: NOW - 30 });
  const rows = buildRows(snap({ current: [only] }), null, NOW * 1000);
  assert.equal(rows[0]!.current?.checkedAt, only.checkedAt);
});

test("a contract with no current_state row still produces a row", () => {
  const rows = buildRows(snap({}), null, NOW * 1000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.current, null);
});

test("the newest change wins when a contract has more than one change row", () => {
  const older = change({ key: "0xc1", changeBlock: 12_077_183n, newValue: IMPL_OLD });
  const newer = change({ key: "0xc2", changeBlock: 12_078_718n, newValue: IMPL_NEW });
  for (const order of [[older, newer], [newer, older]]) {
    const rows = buildRows(snap({ changes: order }), null, NOW * 1000);
    assert.equal(rows[0]!.change?.changeBlock, 12_078_718n);
  }
});

test("the explanation shown is the note for the change shown, not just the newest note", () => {
  // Two changes explained; the row displays the newest change, so it must display that change's
  // note. Pairing a change with another change's explanation would misattribute the text.
  const displayed = change({ changeBlock: 12_078_718n });
  const noteForDisplayed = note({ key: "0xn2", changeBlock: 12_078_718n, requestId: "req-for-displayed" });
  const noteForOther = note({ key: "0xn1", changeBlock: 12_077_183n, requestId: "req-for-other" });
  const rows = buildRows(snap({ changes: [displayed], changeNotes: [noteForOther, noteForDisplayed] }), null, NOW * 1000);
  assert.equal(rows[0]!.changeNote?.requestId, "req-for-displayed");
  assert.equal(rows[0]!.changeNote?.changeBlock, 12_078_718n);
});

test("with no note for the displayed change, the newest note is the fallback rather than an arbitrary one", () => {
  const displayed = change({ changeBlock: 12_079_999n });
  const old = note({ key: "0xn1", changeBlock: 12_074_047n, requestId: "req-old" });
  const newer = note({ key: "0xn2", changeBlock: 12_078_718n, requestId: "req-newer" });
  for (const order of [[old, newer], [newer, old]]) {
    const rows = buildRows(snap({ changes: [displayed], changeNotes: order }), null, NOW * 1000);
    assert.equal(rows[0]!.changeNote?.requestId, "req-newer");
  }
});
