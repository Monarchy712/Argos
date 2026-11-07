/**
 * Paging over the Arkiv node's hard 100-row ceiling.
 *
 * The bug this guards against is silent, not loud: a bare `.limit(100)` returns the first 100
 * rows and no error when there are more, so the 101st monitored contract simply stops existing
 * as far as the UI is concerned. Every assertion here is about *not losing rows*.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_SIZE, pageAll, type Page } from "../src/lib/paging.ts";

/** A fake node holding `total` rows, serving pages the way the SDK does. */
function fakeNode(total: number, opts: { skipPerPage?: number } = {}) {
  const rows = Array.from({ length: total }, (_, i) => `row-${i}`);
  const offsets: number[] = [];
  const skip = opts.skipPerPage ?? 0;
  const fetchPage = async (offset: number): Promise<Page<string>> => {
    offsets.push(offset);
    // The node walks PAGE_SIZE rows from `offset`, returns the ones it kept and counts the rest.
    const walked = rows.slice(offset, offset + PAGE_SIZE);
    const kept = walked.slice(skip);
    return { entities: kept, skipped: walked.length - kept.length };
  };
  return { fetchPage, offsets };
}

test("a result that fits in one page is read in one request", async () => {
  const n = fakeNode(33);
  assert.equal((await pageAll(n.fetchPage)).length, 33);
  assert.deepEqual(n.offsets, [0]);
});

test("exactly 100 rows still probes for a second page, because a full page is not an end signal", async () => {
  const n = fakeNode(PAGE_SIZE);
  assert.equal((await pageAll(n.fetchPage)).length, PAGE_SIZE);
  assert.deepEqual(n.offsets, [0, PAGE_SIZE], "a full first page must not be treated as the end");
});

test("101 rows: the row a bare limit(100) would have silently dropped is returned", async () => {
  const got = await pageAll(fakeNode(101).fetchPage);
  assert.equal(got.length, 101);
  assert.ok(got.includes("row-100"), "the 101st row is exactly what the old code lost");
});

test("several full pages are all read, in order and without duplicates", async () => {
  const got = await pageAll(fakeNode(250).fetchPage);
  assert.equal(got.length, 250);
  assert.equal(new Set(got).size, 250, "no row is fetched twice");
  assert.deepEqual(got, Array.from({ length: 250 }, (_, i) => `row-${i}`), "order is preserved");
});

test("skipped rows advance the offset, so a short page mid-run does not end the read early", async () => {
  // The node drops 10 rows per page (expired, or filtered by creator). Each page therefore
  // returns 90 entities while having walked 100 -- counting only entities would stop here.
  const n = fakeNode(250, { skipPerPage: 10 });
  const got = await pageAll(n.fetchPage);
  assert.equal(got.length, 250 - 10 * n.offsets.length, "every kept row is returned");
  assert.deepEqual(n.offsets, [0, 100, 200], "offset advances by rows walked, not rows kept");
  assert.ok(got.includes("row-240"), "the tail is still reached despite short pages");
});

test("an empty result is an empty list, not an error", async () => {
  assert.deepEqual(await pageAll(fakeNode(0).fetchPage), []);
});

test("a failing page rejects rather than returning a partial list as if it were complete", async () => {
  await assert.rejects(
    pageAll<string>(async (o) => {
      if (o === 0) return { entities: Array.from({ length: PAGE_SIZE }, (_, i) => `row-${i}`), skipped: 0 };
      throw new Error("rate limited");
    }),
    /rate limited/,
    "a truncated read must surface as a failure, never as a shorter portfolio",
  );
});
