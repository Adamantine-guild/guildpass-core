/**
 * backfillService.ts
 *
 * Reusable batched-backfill utility for the "expand" phase of the
 * expand/contract migration pattern documented in CONTRIBUTING.md.
 *
 * When a migration needs to populate a newly-added column (or otherwise
 * rewrite existing rows) on a large, live table, a single `UPDATE ... WHERE`
 * statement can hold row/table locks for the duration of the write and
 * starve concurrent traffic. `runBatchedBackfill` instead walks the table in
 * small, cursor-paginated batches with a configurable delay between them, so
 * each individual write is short-lived and the rest of the application can
 * make progress between batches.
 *
 * Design notes:
 *   - Cursor-based (keyset) pagination, not OFFSET/LIMIT: OFFSET pagination
 *     re-scans skipped rows on every page and drifts if rows are inserted
 *     concurrently. Callers supply `getCursor` to derive the next page's
 *     starting point from the last row of the current batch (e.g. its id).
 *   - Storage-agnostic: `fetchBatch` / `applyBatch` are injected so this
 *     utility has no direct Prisma dependency and can be unit tested with
 *     in-memory fakes, or reused for non-Prisma stores.
 *   - `delayMs` is a cooperative yield, not a hard rate limit — it exists to
 *     avoid saturating the database connection pool / replication lag budget
 *     while a backfill runs alongside live traffic.
 *   - `maxBatches` allows a single invocation to process a bounded slice of
 *     a very large table (e.g. one run per cron tick) and resume later from
 *     the returned cursor, rather than requiring one long-lived process.
 */

export interface BackfillProgress {
  batchesRun: number;
  recordsFetched: number;
  recordsUpdated: number;
  cursor: string | null;
}

export interface BackfillResult {
  /** Number of batches fetched and applied. */
  batchesRun: number;
  /** Total number of records read across all batches. */
  recordsFetched: number;
  /** Total number of records actually mutated by applyBatch. */
  recordsUpdated: number;
  /** The cursor to resume from on the next invocation, if not completed. */
  cursor: string | null;
  /** True if the backfill ran until no more matching rows were found. */
  completed: boolean;
}

export interface BatchedBackfillOptions<T> {
  /**
   * Fetch the next page of records to backfill, starting strictly after
   * `cursor` (null on the first call). Should return fewer than `batchSize`
   * records only when there are no more rows left to process.
   */
  fetchBatch: (cursor: string | null, batchSize: number) => Promise<T[]>;
  /** Derive the pagination cursor from the last record in a batch. */
  getCursor: (record: T) => string;
  /**
   * Apply the backfill mutation to a batch of records (e.g. a single
   * `updateMany` keyed on the batch's ids). Returns the number of records
   * actually updated, for progress reporting.
   */
  applyBatch: (records: T[]) => Promise<number>;
  /** Rows to fetch/update per batch. Default 500. */
  batchSize?: number;
  /** Delay between batches, in milliseconds. Default 200. */
  delayMs?: number;
  /** Stop after this many batches, returning a resumable cursor. Unbounded by default. */
  maxBatches?: number;
  /** Called after each batch is applied; useful for logging/progress bars. */
  onProgress?: (progress: BackfillProgress) => void;
  /** Injectable sleep implementation, primarily for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_DELAY_MS = 200;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk a table in cursor-paginated batches, applying a mutation to each
 * batch with a delay in between to avoid long-running locks on a live,
 * populated database.
 */
export async function runBatchedBackfill<T>(
  options: BatchedBackfillOptions<T>,
): Promise<BackfillResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  if (batchSize <= 0) {
    throw new Error("batchSize must be a positive integer");
  }

  let cursor: string | null = null;
  let batchesRun = 0;
  let recordsFetched = 0;
  let recordsUpdated = 0;

  for (;;) {
    if (options.maxBatches != null && batchesRun >= options.maxBatches) {
      return { batchesRun, recordsFetched, recordsUpdated, cursor, completed: false };
    }

    const batch = await options.fetchBatch(cursor, batchSize);
    if (batch.length === 0) {
      return { batchesRun, recordsFetched, recordsUpdated, cursor, completed: true };
    }

    const updated = await options.applyBatch(batch);

    batchesRun += 1;
    recordsFetched += batch.length;
    recordsUpdated += updated;
    cursor = options.getCursor(batch[batch.length - 1]);

    options.onProgress?.({ batchesRun, recordsFetched, recordsUpdated, cursor });

    const isLastPage = batch.length < batchSize;
    if (isLastPage) {
      return { batchesRun, recordsFetched, recordsUpdated, cursor, completed: true };
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }
}
