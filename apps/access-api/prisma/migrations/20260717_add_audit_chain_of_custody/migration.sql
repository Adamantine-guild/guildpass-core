-- Add correlation ID and on-chain event metadata to AuditEvent
ALTER TABLE "AuditEvent" ADD COLUMN "correlationId" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "chainId" INTEGER;
ALTER TABLE "AuditEvent" ADD COLUMN "txHash" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "blockNumber" INTEGER;
ALTER TABLE "AuditEvent" ADD COLUMN "logIndex" INTEGER;
ALTER TABLE "AuditEvent" ADD COLUMN "membershipStateVersion" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "roleStateVersion" TEXT;

-- Add indexes for traceability
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");
CREATE INDEX "AuditEvent_txHash_idx" ON "AuditEvent"("txHash");

-- Add on-chain event metadata to OutboxEvent.
-- (correlationId is added separately by 20260717_add_outbox_correlation_id,
-- which owns that column's migration and backfill.)
ALTER TABLE "OutboxEvent" ADD COLUMN "chainId" INTEGER;
ALTER TABLE "OutboxEvent" ADD COLUMN "txHash" TEXT;
ALTER TABLE "OutboxEvent" ADD COLUMN "blockNumber" INTEGER;
ALTER TABLE "OutboxEvent" ADD COLUMN "logIndex" INTEGER;
