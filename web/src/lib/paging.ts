/**
 * Paging for Arkiv reads.
 *
 * The node refuses any `limit` above 100 (`MAX_LIMIT` in @arkiv-network/sdk). That is not a
 * tuning knob to raise: a single `.limit(100)` does not error when there are 101 rows, it
 * silently returns the first 100. In this app that means a monitored contract quietly
 * disappearing from My Contracts and from every count — the same class of dishonesty as
 * rendering a failed read as an empty portfolio.
 *
 * `skipped` is part of the stop condition on purpose. The node can omit rows inside a page
 * (expired, filtered by creator), so a page can come back with fewer than 100 `entities` while
 * more rows still follow. Counting only `entities` would stop early and silently drop the tail;
 * `entities + skipped` is how many rows the node actually walked, which is what the next offset
 * has to skip past.
 *
 * Kept in its own module with no Vite-only imports (no `import.meta.env`), so it can be unit
 * tested under plain `node --test` — same reason lib/demo.ts is separate.
 */

/** One page as the SDK returns it: the rows it gave back, and how many it walked past. */
export interface Page<T> {
  entities: readonly T[];
  skipped: number;
}

/** The node's hard ceiling on `limit`. Pages are requested at exactly this size. */
export const PAGE_SIZE = 100;

/** Reads every row by walking pages until one is short, never just the first 100. */
export async function pageAll<T>(fetchPage: (offset: number) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; ) {
    const page = await fetchPage(offset);
    out.push(...page.entities);
    const covered = page.entities.length + page.skipped;
    // A short page is the only end-of-data signal the node gives.
    if (covered < PAGE_SIZE) return out;
    offset += covered;
  }
}
