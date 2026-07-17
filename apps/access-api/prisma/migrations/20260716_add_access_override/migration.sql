-- CreateEnum
CREATE TYPE "AccessOverrideEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateTable
CREATE TABLE "AccessOverride" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "effect" "AccessOverrideEffect" NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessOverride_communityId_wallet_resource_key" ON "AccessOverride"("communityId", "wallet", "resource");

-- CreateIndex
CREATE INDEX "AccessOverride_communityId_idx" ON "AccessOverride"("communityId");
CREATE INDEX "AccessOverride_wallet_idx" ON "AccessOverride"("wallet");
CREATE INDEX "AccessOverride_resource_idx" ON "AccessOverride"("resource");

-- AddForeignKey
ALTER TABLE "AccessOverride"
ADD CONSTRAINT "AccessOverride_communityId_fkey"
FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
