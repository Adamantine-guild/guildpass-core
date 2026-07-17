-- Additive migration: new enum + two new tables only. No existing columns
-- are touched, so this ships as a single direct migration (see
-- CONTRIBUTING.md > "Database Migrations: Direct vs. Expand/Contract").

-- CreateEnum
CREATE TYPE "DeadLetterStatus" AS ENUM ('pending', 'retried', 'resolved');

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "eventTypes" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadLetterEvent" (
    "id" TEXT NOT NULL,
    "originalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "entityId" TEXT,
    "entityType" TEXT,
    "communityId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "failureReason" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL,
    "status" "DeadLetterStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "DeadLetterEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookSubscription_communityId_idx" ON "WebhookSubscription"("communityId");

-- CreateIndex
CREATE INDEX "WebhookSubscription_active_idx" ON "WebhookSubscription"("active");

-- CreateIndex
CREATE INDEX "DeadLetterEvent_status_idx" ON "DeadLetterEvent"("status");

-- CreateIndex
CREATE INDEX "DeadLetterEvent_communityId_idx" ON "DeadLetterEvent"("communityId");

-- CreateIndex
CREATE INDEX "DeadLetterEvent_createdAt_idx" ON "DeadLetterEvent"("createdAt");

-- CreateIndex
CREATE INDEX "DeadLetterEvent_originalEventId_idx" ON "DeadLetterEvent"("originalEventId");
