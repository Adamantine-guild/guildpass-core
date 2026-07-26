-- Additive new table: safe to apply directly against a live database with a
-- single `migrate deploy`. No existing table or column is touched, so there
-- is no dual-write/backfill phase to sequence — see CONTRIBUTING.md >
-- "Database Migrations: Direct vs. Expand/Contract" for why this qualifies
-- as the simple, direct case.

-- CreateEnum
CREATE TYPE "IdempotencyKeyStatus" AS ENUM ('pending', 'completed');

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "IdempotencyKeyStatus" NOT NULL DEFAULT 'pending',
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Enforces "same key + route = single outcome" at the DB level, which is
-- also what we rely on to resolve the race between two concurrent retries
-- that both miss the initial SELECT: the loser's INSERT fails P2002 and is
-- told to treat the request as already in-flight rather than double-write.
CREATE UNIQUE INDEX "IdempotencyKey_key_route_key" ON "IdempotencyKey"("key", "route");

-- CreateIndex
-- Serves the periodic cleanup job's `WHERE expiresAt < now()` sweep.
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");
