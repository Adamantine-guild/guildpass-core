-- Additive, nullable column: safe to apply directly against a live database
-- with a single `migrate deploy`. No dual-write or backfill phase is
-- required before this migration ships, because existing rows are valid
-- with correlationId = NULL and no application code depends on the column
-- being populated yet.
--
-- See CONTRIBUTING.md > "Database Migrations: Direct vs. Expand/Contract"
-- for why this qualifies as the simple, direct case, and
-- scripts/backfillOutboxCorrelationId.ts for the optional batched backfill
-- that assigns a value to pre-existing rows after this migration ships.
ALTER TABLE "OutboxEvent" ADD COLUMN "correlationId" TEXT;

-- CreateIndex
CREATE INDEX "OutboxEvent_correlationId_idx" ON "OutboxEvent"("correlationId");
