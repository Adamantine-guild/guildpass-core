CREATE TABLE "MembershipToken" (
    "id" TEXT NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 31337,
    "contractAddress" TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
    "memberId" TEXT NOT NULL,
    "state" "MembershipState" NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "renewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MembershipToken_chainId_contractAddress_tokenId_key"
    ON "MembershipToken"("chainId", "contractAddress", "tokenId");

CREATE UNIQUE INDEX "MembershipToken_chainId_tokenId_key"
    ON "MembershipToken"("chainId", "tokenId");

CREATE INDEX "MembershipToken_state_expiresAt_idx"
    ON "MembershipToken"("state", "expiresAt");

CREATE INDEX "MembershipToken_tokenId_idx"
    ON "MembershipToken"("tokenId");

CREATE INDEX "MembershipToken_chainId_idx"
    ON "MembershipToken"("chainId");

ALTER TABLE "MembershipToken"
    ADD CONSTRAINT "MembershipToken_memberId_fkey"
    FOREIGN KEY ("memberId")
    REFERENCES "Member"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;
-- Suspension appeals workflow (#249)
-- Also restores Membership.activeTokenId for multi-token membership relation.

-- Membership.activeTokenId (may already exist in some environments)
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "activeTokenId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Membership_activeTokenId_key'
  ) THEN
    ALTER TABLE "Membership" ADD CONSTRAINT "Membership_activeTokenId_key" UNIQUE ("activeTokenId");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Membership_activeTokenId_fkey'
  ) THEN
    ALTER TABLE "Membership"
      ADD CONSTRAINT "Membership_activeTokenId_fkey"
      FOREIGN KEY ("activeTokenId") REFERENCES "MembershipToken"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- SuspensionAppealStatus enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SuspensionAppealStatus') THEN
    CREATE TYPE "SuspensionAppealStatus" AS ENUM ('pending', 'approved', 'denied');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "SuspensionAppeal" (
  "id" TEXT NOT NULL,
  "membershipId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "wallet" TEXT NOT NULL,
  "communityId" TEXT NOT NULL,
  "memberStatement" TEXT NOT NULL,
  "status" "SuspensionAppealStatus" NOT NULL DEFAULT 'pending',
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewerId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewerRationale" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SuspensionAppeal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SuspensionAppeal_communityId_status_submittedAt_idx"
  ON "SuspensionAppeal"("communityId", "status", "submittedAt");

CREATE INDEX IF NOT EXISTS "SuspensionAppeal_memberId_status_idx"
  ON "SuspensionAppeal"("memberId", "status");

CREATE INDEX IF NOT EXISTS "SuspensionAppeal_wallet_communityId_idx"
  ON "SuspensionAppeal"("wallet", "communityId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SuspensionAppeal_memberId_fkey'
  ) THEN
    ALTER TABLE "SuspensionAppeal"
      ADD CONSTRAINT "SuspensionAppeal_memberId_fkey"
      FOREIGN KEY ("memberId") REFERENCES "Member"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SuspensionAppeal_communityId_fkey'
  ) THEN
    ALTER TABLE "SuspensionAppeal"
      ADD CONSTRAINT "SuspensionAppeal_communityId_fkey"
      FOREIGN KEY ("communityId") REFERENCES "Community"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
