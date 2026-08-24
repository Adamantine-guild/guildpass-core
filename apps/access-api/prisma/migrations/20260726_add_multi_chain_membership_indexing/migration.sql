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

-- The original single-chain indexer models were added to schema.prisma without
-- a corresponding migration. Create their pre-multichain shape here before
-- extending them below. Keeping this in the same migration makes a clean
-- migrate deploy work as well as preserving the intended upgrade sequence.
CREATE TABLE "ProcessedEvent" (
  "id" TEXT NOT NULL,
  "transactionHash" TEXT NOT NULL,
  "logIndex" INTEGER NOT NULL,
  "blockHash" TEXT NOT NULL,
  "blockNumber" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProcessedEvent_transactionHash_logIndex_key"
  ON "ProcessedEvent"("transactionHash", "logIndex");
CREATE INDEX "ProcessedEvent_blockHash_idx" ON "ProcessedEvent"("blockHash");
CREATE INDEX "ProcessedEvent_blockNumber_idx" ON "ProcessedEvent"("blockNumber");

CREATE TABLE "IndexerState" (
  "id" TEXT NOT NULL,
  "lastBlockNumber" INTEGER NOT NULL,
  "lastBlockHash" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IndexerCheckpoint" (
  "chainId" INTEGER NOT NULL,
  "contractAddress" TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  "lastProcessedBlock" INTEGER NOT NULL,
  "lastProcessedBlockNumber" INTEGER NOT NULL DEFAULT 0,
  "lastProcessedBlockHash" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IndexerCheckpoint_pkey" PRIMARY KEY ("chainId", "contractAddress")
);

CREATE TABLE "BlockHeader" (
  "chainId" INTEGER NOT NULL,
  "blockNumber" INTEGER NOT NULL,
  "blockHash" TEXT NOT NULL,
  CONSTRAINT "BlockHeader_pkey" PRIMARY KEY ("chainId", "blockNumber")
);

CREATE INDEX "BlockHeader_blockNumber_idx" ON "BlockHeader"("blockNumber");

ALTER TABLE "Community" ADD COLUMN "chainConfigId" TEXT;
CREATE INDEX "Community_chainConfigId_idx" ON "Community"("chainConfigId");
ALTER TABLE "Community" ADD CONSTRAINT "Community_chainConfigId_fkey" FOREIGN KEY ("chainConfigId") REFERENCES "ChainConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Membership" 
ADD COLUMN "tokenId" INTEGER,
ADD COLUMN "chainId" INTEGER;
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
