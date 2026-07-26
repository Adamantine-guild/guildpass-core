-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'CONTRACT_ADMIN_UPDATED';
ALTER TYPE "EventType" ADD VALUE 'CONTRACT_OWNERSHIP_TRANSFERRED';

-- CreateTable
CREATE TABLE "ContractAdmin" (
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractAdmin_pkey" PRIMARY KEY ("chainId","address")
);

-- CreateTable
CREATE TABLE "ContractOwnership" (
    "chainId" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "proposedOwner" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractOwnership_pkey" PRIMARY KEY ("chainId")
);
