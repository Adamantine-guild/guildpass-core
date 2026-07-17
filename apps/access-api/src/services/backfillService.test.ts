/**
 * backfillService.test.ts
 *
 * Tests for the reusable batched-backfill utility covering:
 *   - Multi-batch pagination via cursor
 *   - Delay between batches (but not after the final batch)
 *   - maxBatches resumability
 *   - Progress reporting
 *   - Edge cases: empty table, invalid batch size
 */

import { runBatchedBackfill } from "./backfillService";

interface FakeRow {
  id: number;
  value: string | null;
}

function makeRows(count: number): FakeRow[] {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, value: null }));
}

function makeFetcher(rows: FakeRow[]) {
  return async (cursor: string | null, batchSize: number): Promise<FakeRow[]> => {
    const startIndex = cursor == null ? 0 : rows.findIndex((r) => String(r.id) === cursor) + 1;
    return rows.slice(startIndex, startIndex + batchSize);
  };
}

describe("runBatchedBackfill", () => {
  test("processes all rows across multiple batches", async () => {
    const rows = makeRows(10);
    const applied: FakeRow[][] = [];

    const result = await runBatchedBackfill<FakeRow>({
      fetchBatch: makeFetcher(rows),
      getCursor: (r) => String(r.id),
      applyBatch: async (batch) => {
        applied.push(batch);
        batch.forEach((r) => (r.value = "backfilled"));
        return batch.length;
      },
      batchSize: 3,
      delayMs: 0,
    });

    expect(result.completed).toBe(true);
    expect(result.recordsFetched).toBe(10);
    expect(result.recordsUpdated).toBe(10);
    expect(result.batchesRun).toBe(4); // 3,3,3,1
    expect(applied.map((b) => b.length)).toEqual([3, 3, 3, 1]);
    expect(rows.every((r) => r.value === "backfilled")).toBe(true);
  });

  test("returns completed with zero batches for an empty table", async () => {
    const result = await runBatchedBackfill<FakeRow>({
      fetchBatch: async () => [],
      getCursor: (r) => String(r.id),
      applyBatch: async (batch) => batch.length,
      delayMs: 0,
    });

    expect(result.completed).toBe(true);
    expect(result.batchesRun).toBe(0);
    expect(result.recordsFetched).toBe(0);
    expect(result.recordsUpdated).toBe(0);
    expect(result.cursor).toBeNull();
  });

  test("sleeps between batches but not after the final batch", async () => {
    const rows = makeRows(7);
    const sleepCalls: number[] = [];

    const result = await runBatchedBackfill<FakeRow>({
      fetchBatch: makeFetcher(rows),
      getCursor: (r) => String(r.id),
      applyBatch: async (batch) => batch.length,
      batchSize: 3,
      delayMs: 50,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(result.batchesRun).toBe(3); // 3,3,1
    // Sleeps between batch 1->2 and 2->3, but not after the final (partial) batch.
    expect(sleepCalls).toEqual([50, 50]);
  });

  test("stops after maxBatches and returns a resumable cursor", async () => {
    const rows = makeRows(10);
    const fetcher = makeFetcher(rows);

    const firstRun = await runBatchedBackfill<FakeRow>({
      fetchBatch: fetcher,
      getCursor: (r) => String(r.id),
      applyBatch: async (batch) => batch.length,
      batchSize: 3,
      delayMs: 0,
      maxBatches: 2,
    });

    expect(firstRun.completed).toBe(false);
    expect(firstRun.batchesRun).toBe(2);
    expect(firstRun.recordsFetched).toBe(6);
    expect(firstRun.cursor).toBe("6");

    // Resuming from the returned cursor should process exactly the remaining rows.
    const secondRun = await runBatchedBackfill<FakeRow>({
      fetchBatch: (cursor, batchSize) => fetcher(cursor ?? firstRun.cursor, batchSize),
      getCursor: (r) => String(r.id),
      applyBatch: async (batch) => batch.length,
      batchSize: 3,
      delayMs: 0,
    });

    expect(secondRun.completed).toBe(true);
    expect(secondRun.recordsFetched).toBe(4);
  });

  test("reports progress after each batch", async () => {
    const rows = makeRows(4);
    const progressSnapshots: number[] = [];

    await runBatchedBackfill<FakeRow>({
      fetchBatch: makeFetcher(rows),
      getCursor: (r) => String(r.id),
      applyBatch: async (batch) => batch.length,
      batchSize: 2,
      delayMs: 0,
      onProgress: (progress) => progressSnapshots.push(progress.recordsFetched),
    });

    expect(progressSnapshots).toEqual([2, 4]);
  });

  test("recordsUpdated can be lower than recordsFetched when applyBatch skips rows", async () => {
    const rows = makeRows(5);

    const result = await runBatchedBackfill<FakeRow>({
      fetchBatch: makeFetcher(rows),
      getCursor: (r) => String(r.id),
      // Simulate a concurrent write racing the backfill: only even ids get updated.
      applyBatch: async (batch) => batch.filter((r) => r.id % 2 === 0).length,
      batchSize: 5,
      delayMs: 0,
    });

    expect(result.recordsFetched).toBe(5);
    expect(result.recordsUpdated).toBe(2);
  });

  test("rejects a non-positive batch size", async () => {
    await expect(
      runBatchedBackfill<FakeRow>({
        fetchBatch: async () => [],
        getCursor: (r) => String(r.id),
        applyBatch: async () => 0,
        batchSize: 0,
      }),
    ).rejects.toThrow(/batchSize/);
  });
});
