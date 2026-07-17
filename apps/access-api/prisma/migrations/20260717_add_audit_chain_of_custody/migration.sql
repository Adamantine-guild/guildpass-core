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

-- Add correlation ID and on-chain event metadata to OutboxEvent
ALTER TABLE "OutboxEvent" ADD COLUMN "correlationId" TEXT;
ALTER TABLE "OutboxEvent" ADD COLUMN "chainId" INTEGER;
ALTER TABLE "OutboxEvent" ADD COLUMN "txHash" TEXT;
ALTER TABLE "OutboxEvent" ADD COLUMN "blockNumber" INTEGER;
ALTER TABLE "OutboxEvent" ADD COLUMN "logIndex" INTEGER;

-- Add index for traceability
CREATE INDEX "OutboxEvent_correlationId_idx" ON "OutboxEvent"("correlationId");
