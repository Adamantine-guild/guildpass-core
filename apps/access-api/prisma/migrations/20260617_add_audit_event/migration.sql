-- This migration adds the AuditEvent table and EventType enum.

CREATE TYPE "EventType" AS ENUM (
  'ACCESS_CHECK',
  'MEMBERSHIP_CREATED',
  'MEMBERSHIP_UPDATED',
  'MEMBERSHIP_DELETED',
  'POLICY_EVALUATION',
  'OTHER'
);

CREATE TABLE "AuditEvent" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "eventType" "EventType" NOT NULL,
  "walletId" TEXT,
  "communityId" TEXT,
  "resource" TEXT,
  "policyRule" TEXT,
  "decision" TEXT,
  "reasonCode" TEXT,
  "beforeState" JSONB,
  "afterState" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "AuditEvent_walletId_idx" ON "AuditEvent" ("walletId");
CREATE INDEX "AuditEvent_communityId_idx" ON "AuditEvent" ("communityId");
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent" ("createdAt");
