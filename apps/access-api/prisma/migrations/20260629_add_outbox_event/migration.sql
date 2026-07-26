-- Required for uuid_generate_v4() below.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create OutboxEvent table for durable integration events
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "eventType" VARCHAR(128) NOT NULL,
    "entityId" VARCHAR(255),
    "entityType" VARCHAR(64),
    "communityId" VARCHAR(255),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OutboxEvent_status_idx" ON "OutboxEvent"("status");
CREATE INDEX "OutboxEvent_communityId_idx" ON "OutboxEvent"("communityId");
CREATE INDEX "OutboxEvent_eventType_idx" ON "OutboxEvent"("eventType");
CREATE INDEX "OutboxEvent_createdAt_idx" ON "OutboxEvent"("createdAt");
CREATE INDEX "OutboxEvent_nextRetryAt_idx" ON "OutboxEvent"("nextRetryAt");
CREATE INDEX "OutboxEvent_status_nextRetryAt_idx" ON "OutboxEvent"("status", "nextRetryAt");
