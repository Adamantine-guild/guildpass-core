/**
 * backfillOutboxCorrelationId.ts
 *
 * Worked example of the reusable batched-backfill utility
 * (src/services/backfillService.ts), applied to the `OutboxEvent.correlationId`
 * column added in migrations/20260717_add_outbox_correlation_id.
 *
 * That migration is additive and nullable, so it does NOT require this
 * script before it ships — see CONTRIBUTING.md's "Direct vs. Expand/Contract"
 * section for why. This script is an optional follow-up: it gives
 * historical rows (created before correlationId existed) a stable,
 * non-null value instead of leaving them permanently NULL, without holding
 * a single long-running lock on the OutboxEvent table.
 *
 * Backfill choice: pre-existing rows have no recorded correlation group
 * (correlation was not tracked yet), so each one is assigned its own id as
 * its correlationId — every legacy event becomes a correlation group of one.
 * This is idempotent (rows are only selected while correlationId IS NULL)
 * and safe to run multiple times or resume after an interruption.
 *
 * Usage:
 *   pnpm --filter access-api run backfill:outbox-correlation-id
 *   BACKFILL_BATCH_SIZE=200 BACKFILL_DELAY_MS=500 pnpm --filter access-api run backfill:outbox-correlation-id
 */

import { getPrisma, disconnectPrisma } from '../src/services/prisma';
import { runBatchedBackfill } from '../src/services/backfillService';

async function main() {
  const prisma = getPrisma();

  const batchSize = Number(process.env.BACKFILL_BATCH_SIZE ?? 500);
  const delayMs = Number(process.env.BACKFILL_DELAY_MS ?? 200);

  const result = await runBatchedBackfill<{ id: string }>({
    batchSize,
    delayMs,
    fetchBatch: (cursor, limit) =>
      prisma.outboxEvent.findMany({
        where: {
          correlationId: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: limit,
      }),
    getCursor: (row) => row.id,
    applyBatch: async (rows) => {
      // Each row gets its own id as its correlationId — see rationale above.
      // Guarded by `correlationId: null` so a row already backfilled by a
      // concurrent/retried run is never double-counted or overwritten.
      const results = await prisma.$transaction(
        rows.map((row) =>
          prisma.outboxEvent.updateMany({
            where: { id: row.id, correlationId: null },
            data: { correlationId: row.id },
          }),
        ),
      );
      return results.reduce((sum, r) => sum + r.count, 0);
    },
    onProgress: ({ batchesRun, recordsFetched, recordsUpdated }) => {
      // eslint-disable-next-line no-console
      console.log(
        `[backfillOutboxCorrelationId] batch=${batchesRun} fetched=${recordsFetched} updated=${recordsUpdated}`,
      );
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    `[backfillOutboxCorrelationId] done: completed=${result.completed} ` +
      `batches=${result.batchesRun} fetched=${result.recordsFetched} updated=${result.recordsUpdated}`,
  );

  await disconnectPrisma();
}

main().catch(async (err) => {
  console.error('[backfillOutboxCorrelationId] failed:', err);
  await disconnectPrisma();
  process.exit(1);
});
