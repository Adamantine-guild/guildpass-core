-- Multi-chain membership indexing configuration.
CREATE TABLE "ChainConfig" (
  "id" TEXT NOT NULL,
  "chainId" INTEGER NOT NULL,
  "name" TEXT,
  "rpcUrl" TEXT NOT NULL,
  "membershipNftAddress" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChainConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChainConfig_chainId_membershipNftAddress_key" ON "ChainConfig"("chainId", "membershipNftAddress");
CREATE INDEX "ChainConfig_chainId_idx" ON "ChainConfig"("chainId");
CREATE INDEX "ChainConfig_enabled_idx" ON "ChainConfig"("enabled");

ALTER TABLE "Community" ADD COLUMN "chainConfigId" TEXT;
CREATE INDEX "Community_chainConfigId_idx" ON "Community"("chainConfigId");
ALTER TABLE "Community" ADD CONSTRAINT "Community_chainConfigId_fkey" FOREIGN KEY ("chainConfigId") REFERENCES "ChainConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Membership" ADD COLUMN "chainId" INTEGER;
DROP INDEX IF EXISTS "Membership_tokenId_key";
CREATE UNIQUE INDEX "Membership_chainId_tokenId_key" ON "Membership"("chainId", "tokenId");
CREATE INDEX "Membership_chainId_idx" ON "Membership"("chainId");

-- Preserve existing singleton deployments by seeding ChainConfig from legacy env values in application seed/backfill code.
ALTER TABLE "ProcessedEvent" ADD COLUMN "chainId" INTEGER NOT NULL DEFAULT 31337;
DROP INDEX IF EXISTS "ProcessedEvent_transactionHash_logIndex_key";
CREATE UNIQUE INDEX "ProcessedEvent_chainId_transactionHash_logIndex_key" ON "ProcessedEvent"("chainId", "transactionHash", "logIndex");
CREATE INDEX "ProcessedEvent_chainId_blockNumber_idx" ON "ProcessedEvent"("chainId", "blockNumber");

ALTER TABLE "IndexerState" ADD COLUMN "chainId" INTEGER NOT NULL DEFAULT 31337;
ALTER TABLE "IndexerState" ADD COLUMN "contractAddress" TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000';
UPDATE "IndexerState" SET "id" = "chainId" || ':' || lower("contractAddress") WHERE "id" = 'singleton';
CREATE UNIQUE INDEX "IndexerState_chainId_contractAddress_key" ON "IndexerState"("chainId", "contractAddress");
CREATE INDEX "IndexerState_chainId_idx" ON "IndexerState"("chainId");
