-- Additive, nullable columns: safe to apply directly against a live database
-- with a single `migrate deploy`. No dual-write or backfill phase is
-- required before this migration ships, because existing rows are valid
-- with claimedAt/claimedBy/claimExpiresAt = NULL and no application code
-- depends on them being populated until the distributed-locking claim path
-- (outboxService.ts#claimPendingOutboxEvents) ships alongside this migration.
--
-- See CONTRIBUTING.md > "Database Migrations: Direct vs. Expand/Contract"
-- for why this qualifies as the simple, direct case.
ALTER TABLE "OutboxEvent" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "OutboxEvent" ADD COLUMN "claimedBy" TEXT;
ALTER TABLE "OutboxEvent" ADD COLUMN "claimExpiresAt" TIMESTAMP(3);

-- No new index: verified with EXPLAIN ANALYZE against 100k seeded rows
-- (90% pending/leased, a high-contention shape), both with matching rows
-- at the front and at the far end of the createdAt order (worst case).
-- The claim query's subquery predicate
-- (status = 'pending' AND nextRetryAt <= now() AND (claimExpiresAt IS NULL OR claimExpiresAt < now()))
-- is resolved via the pre-existing "OutboxEvent_createdAt_idx" (walked in
-- the query's own ORDER BY order, filtering as it goes, stopping at
-- LIMIT), falling back to a sequential scan if that index is unavailable.
-- The pre-existing "OutboxEvent_status_nextRetryAt_idx" is not what
-- resolves it: a composite (status, nextRetryAt, claimExpiresAt) index was
-- tried and never chosen by the planner in either seeded shape, and
-- dropping "OutboxEvent_status_nextRetryAt_idx" itself produced an
-- identical plan and cost — status alone has poor selectivity here (most
-- pending rows are also past nextRetryAt), so an index scan on it costs
-- about the same as a sequential scan. An unused index is a permanent
-- write-path cost on a hot table, so neither was added.
