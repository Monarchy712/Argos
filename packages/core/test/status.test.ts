import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStatus, type StatusInput, type StatusResult } from "../src/status.ts";

const A = ("0x" + "aa".repeat(32)) as `0x${string}`;
const B = ("0x" + "bb".repeat(32)) as `0x${string}`;
const NOW = 1_800_000_000;

const base: StatusInput = {
  now: NOW,
  monitored: true,
  supported: true,
  baseline: { codeIdentity: A, block: 100n },
  current: { codeIdentity: A, matchesBaseline: true, everChangedSinceBaseline: false, checkedBlock: 200n, checkedAt: NOW - 30, expiresAt: NOW + 570 },
  latestChange: null,
  live: { state: "not-run" },
};
const all: StatusResult[] = [];
const run = (patch: Partial<StatusInput>) => {
  const r = computeStatus({ ...base, ...patch });
  all.push(r);
  return r;
};

test("fresh matching watcher record → GREEN", () => {
  const r = run({});
  assert.equal(r.status, "GREEN");
  assert.equal(r.note, undefined);
});

test("A→B: watcher mismatch → RED", () => {
  const r = run({
    current: { ...base.current!, codeIdentity: B, matchesBaseline: false, everChangedSinceBaseline: true },
    latestChange: { field: "implementation", changeBlock: 150n, txHash: "0x1" },
  });
  assert.equal(r.status, "RED");
  assert.match(r.reasons[0]!, /block 150/);
});

test("A→B→A: matches now but changed before → GREEN with the note", () => {
  const r = run({
    current: { ...base.current!, everChangedSinceBaseline: true },
    latestChange: { field: "implementation", changeBlock: 160n, txHash: "0x2" },
  });
  assert.equal(r.status, "GREEN");
  assert.equal(r.note, "Matches baseline now, but a change was previously detected (block 160).");
});

test("no current_state (expired and gone from queries) → NOT VERIFIED", () => {
  const r = run({ current: null });
  assert.equal(r.status, "NOT_VERIFIED");
  assert.match(r.reasons[0]!, /expired|never written/);
});

test("current_state past its expiresAt → NOT VERIFIED", () => {
  const r = run({ current: { ...base.current!, expiresAt: NOW - 1 } });
  assert.equal(r.status, "NOT_VERIFIED");
  assert.match(r.reasons[0]!, /expired/);
});

test("stale checked_at (> 5 min) → NOT VERIFIED", () => {
  const r = run({ current: { ...base.current!, checkedAt: NOW - 301 } });
  assert.equal(r.status, "NOT_VERIFIED");
  assert.match(r.reasons[0]!, /stale/);
});

test("stale but mismatching is still RED (a change was seen)", () => {
  const r = run({ current: { ...base.current!, checkedAt: NOW - 3600, matchesBaseline: false, codeIdentity: B } });
  assert.equal(r.status, "RED");
});

test("unsupported proxy → NOT VERIFIED, never GREEN", () => {
  const r = run({ supported: false });
  assert.equal(r.status, "NOT_VERIFIED");
  assert.equal(r.headline, "Unsupported proxy pattern");
});

test("not monitored / no baseline → NOT VERIFIED", () => {
  assert.equal(run({ monitored: false }).status, "NOT_VERIFIED");
  assert.equal(run({ baseline: null }).status, "NOT_VERIFIED");
});

test("live read differs from baseline → RED even if the watcher says GREEN", () => {
  const r = run({ live: { state: "ok", codeIdentity: B, block: 210n } });
  assert.equal(r.status, "RED");
  assert.match(r.reasons.join(" "), /live read at block 210 differs/);
});

test("live read matches → GREEN mentions it", () => {
  const r = run({ live: { state: "ok", codeIdentity: A, block: 210n } });
  assert.equal(r.status, "GREEN");
  assert.match(r.reasons.join(" "), /live read at block 210 matches/);
});

test("live read failed or pending → NOT VERIFIED (no silent pass)", () => {
  assert.equal(run({ live: { state: "failed", error: "worker not ready" } }).status, "NOT_VERIFIED");
  assert.equal(run({ live: { state: "pending" } }).status, "NOT_VERIFIED");
});

test("watcher mismatch but live read back at baseline → still RED, says so", () => {
  const r = run({
    current: { ...base.current!, codeIdentity: B, matchesBaseline: false, everChangedSinceBaseline: true },
    live: { state: "ok", codeIdentity: A, block: 220n },
  });
  assert.equal(r.status, "RED");
  assert.match(r.reasons.join(" "), /matches the baseline again/);
});

test("wording never judges intent", () => {
  for (const r of all) {
    const text = [r.headline, ...r.reasons, r.note ?? ""].join(" ").toLowerCase();
    assert.doesNotMatch(text, /malicious|unsafe|attack|scam|exploit/);
    assert.doesNotMatch(text, /\bsafe\b/);
  }
});
