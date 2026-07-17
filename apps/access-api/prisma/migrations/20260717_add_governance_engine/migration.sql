-- Constitutional Governance Engine Migration

-- Create GovernanceRule table
CREATE TABLE "GovernanceRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "ast" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GovernanceRule_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Create indexes for GovernanceRule
CREATE INDEX "GovernanceRule_communityId_idx" ON "GovernanceRule"("communityId");
CREATE INDEX "GovernanceRule_resource_idx" ON "GovernanceRule"("resource");
CREATE INDEX "GovernanceRule_active_idx" ON "GovernanceRule"("active");
CREATE UNIQUE INDEX "GovernanceRule_communityId_resource_name_key" ON "GovernanceRule"("communityId", "resource", "name");

-- Create ApprovalRequestStatus enum
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- Create ApprovalRequest table
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "communityId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "requesterWallet" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Create indexes for ApprovalRequest
CREATE INDEX "ApprovalRequest_communityId_idx" ON "ApprovalRequest"("communityId");
CREATE INDEX "ApprovalRequest_requesterWallet_idx" ON "ApprovalRequest"("requesterWallet");
CREATE INDEX "ApprovalRequest_ruleId_idx" ON "ApprovalRequest"("ruleId");
CREATE INDEX "ApprovalRequest_status_idx" ON "ApprovalRequest"("status");
CREATE INDEX "ApprovalRequest_createdAt_idx" ON "ApprovalRequest"("createdAt");

-- Create Approval table
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "approverWallet" TEXT NOT NULL,
    "approverRole" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature" TEXT,
    CONSTRAINT "Approval_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ApprovalRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Create indexes for Approval
CREATE INDEX "Approval_requestId_idx" ON "Approval"("requestId");
CREATE INDEX "Approval_approverWallet_idx" ON "Approval"("approverWallet");
CREATE UNIQUE INDEX "Approval_requestId_approverWallet_key" ON "Approval"("requestId", "approverWallet");

-- Create ContributionScore table
CREATE TABLE "ContributionScore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "totalScore" INTEGER NOT NULL DEFAULT 0,
    "breakdown" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Create indexes for ContributionScore
CREATE UNIQUE INDEX "ContributionScore_walletId_communityId_key" ON "ContributionScore"("walletId", "communityId");
CREATE INDEX "ContributionScore_communityId_idx" ON "ContributionScore"("communityId");
CREATE INDEX "ContributionScore_totalScore_idx" ON "ContributionScore"("totalScore");
