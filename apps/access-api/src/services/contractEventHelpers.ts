/**
 * Contract Event Processing Helpers
 *
 * This module provides utilities for decoding and applying MembershipNFT contract events
 * to the database. It serves both as a foundation for event indexer implementation and
 * as a test helper for integration tests.
 *
 * These helpers bridge the gap between contract events and database state updates.
 */

import type { PrismaClient } from '@prisma/client';
import { writeChainedAuditEvent } from './auditChainHasher';

/**
 * Decoded contract event types - derived from MembershipNFT.sol
 */

export interface DecodedMembershipMintedEvent {
  type: 'MembershipMinted';
  to: string; // wallet address
  tokenId: number;
  communityId: string;
  expiresAt: number; // unix timestamp
  chainId?: number;
  blockNumber?: number;
  blockHash?: string;
  transactionHash?: string;
  txHash?: string;
  logIndex?: number;
}

export interface DecodedMembershipRenewedEvent {
  type: 'MembershipRenewed';
  tokenId: number;
  newExpiresAt: number; // unix timestamp
  chainId?: number;
  blockNumber?: number;
  blockHash?: string;
  transactionHash?: string;
  txHash?: string;
  logIndex?: number;
}

export interface DecodedMembershipSuspendedEvent {
  type: 'MembershipSuspended';
  tokenId: number;
  isSuspended: boolean;
  chainId?: number;
  blockNumber?: number;
  blockHash?: string;
  transactionHash?: string;
  txHash?: string;
  logIndex?: number;
}

export type DecodedContractEvent =
  | DecodedMembershipMintedEvent
  | DecodedMembershipRenewedEvent
  | DecodedMembershipSuspendedEvent;

/**
 * Validates that required fields exist in an event
 */
function validateEvent(event: DecodedContractEvent): void {
  if (event.type === 'MembershipMinted') {
    if (!event.to || !event.tokenId || !event.communityId || !event.expiresAt) {
      throw new Error('Invalid MembershipMinted event: missing required fields');
    }
  } else if (event.type === 'MembershipRenewed') {
    if (!event.tokenId || !event.newExpiresAt) {
      throw new Error('Invalid MembershipRenewed event: missing required fields');
    }
  } else if (event.type === 'MembershipSuspended') {
    if (!event.tokenId || event.isSuspended === undefined) {
      throw new Error('Invalid MembershipSuspended event: missing required fields');
    }
  }
}

/**
 * Apply a decoded contract event to the database
 *
 * This function handles creating or updating wallet, community, member, and membership records
 * based on contract events. It is idempotent and safe to call multiple times with the same event.
 * 
 * Creates audit trail entries linking on-chain events to database state changes for complete traceability.
 *
 * @param prisma - PrismaClient instance
 * @param event - Decoded contract event
 * @returns The updated or created membership record
 */
export async function applyContractEvent(
  prisma: PrismaClient,
  event: DecodedContractEvent,
): Promise<void> {
  validateEvent(event);

  const txHash = event.transactionHash ?? event.txHash;

  // Generate correlation ID to link all related events
  const correlationId = `${txHash || 'unknown'}_${event.logIndex ?? 0}_${Date.now()}`;

  // Access-affecting writes must be atomic.
  await prisma.$transaction(async (tx) => {
    // Idempotency check: If transactionHash and logIndex are provided, check if already processed.
    if (txHash && event.logIndex !== undefined) {
      const alreadyProcessed = await tx.processedEvent.findUnique({
        where: {
          transactionHash_logIndex: {
            transactionHash: txHash,
            logIndex: event.logIndex,
          },
        },
      });

      if (alreadyProcessed) {
        // Already processed, skip to maintain idempotency.
        return;
      }
    }

    if (event.type === 'MembershipMinted') {
      const wallet = event.to.toLowerCase();
      const expiresAt = new Date(event.expiresAt * 1000);

      // Ensure wallet exists
      const walletRecord = await tx.wallet.upsert({
        where: { address: wallet },
        update: {},
        create: { address: wallet },
      });

      // Ensure community exists
      await tx.community.upsert({
        where: { id: event.communityId },
        update: {},
        create: {
          id: event.communityId,
          name: `${event.communityId} Community`,
        },
      });

      // Ensure member exists in community
      const member = await tx.member.upsert({
        where: {
          communityId_walletId: {
            communityId: event.communityId,
            walletId: walletRecord.id,
          },
        },
        update: {},
        create: {
          communityId: event.communityId,
          walletId: walletRecord.id,
        },
      });

      // Capture before state for audit trail
      const existingMembership = await tx.membership.findUnique({
        where: { memberId: member.id },
      });

      // Create or update membership
      // Note: If a member receives a second MembershipMinted for the same community,
      // this updates their existing membership (replacing the tokenId and resetting state)
      const updatedMembership = await tx.membership.upsert({
        where: { memberId: member.id },
        update: {
          tokenId: event.tokenId,
          state: 'active',
          expiresAt,
          renewedAt: new Date(),
        },
        create: {
          memberId: member.id,
          tokenId: event.tokenId,
          state: 'active',
          expiresAt,
        },
      });

      // Create audit event with on-chain metadata and hash-chain integrity
      await writeChainedAuditEvent(tx, {
        eventType: 'MEMBERSHIP_CREATED',
        walletId: wallet,
        communityId: event.communityId,
        correlationId,
        chainId: event.chainId ?? null,
        txHash: txHash ?? null,
        blockNumber: event.blockNumber ?? null,
        logIndex: event.logIndex ?? null,
        beforeState: (existingMembership ? {
          tokenId: existingMembership.tokenId,
          state: existingMembership.state,
          expiresAt: existingMembership.expiresAt?.toISOString(),
        } : null) as any,
        afterState: {
          tokenId: updatedMembership.tokenId,
          state: updatedMembership.state,
          expiresAt: updatedMembership.expiresAt?.toISOString(),
        },
      });

      // Create outbox event with on-chain metadata for downstream consumers
      await tx.outboxEvent.create({
        data: {
          eventType: 'MEMBERSHIP_CREATED',
          entityId: updatedMembership.id,
          entityType: 'Membership',
          communityId: event.communityId,
          correlationId,
          chainId: event.chainId ?? null,
          txHash: txHash ?? null,
          blockNumber: event.blockNumber ?? null,
          logIndex: event.logIndex ?? null,
          payload: {
            memberId: member.id,
            tokenId: event.tokenId,
            wallet,
            expiresAt: expiresAt.toISOString(),
          },
          status: 'pending',
          nextRetryAt: new Date(),
        },
      });
    } else if (event.type === 'MembershipRenewed') {
      const membership = await tx.membership.findFirst({
        where: {
          tokenId: event.tokenId,
        },
        include: {
          member: {
            include: {
              wallet: true,
            },
          },
        },
      });

      if (!membership) {
        throw new Error(
          `Cannot renew membership: tokenId ${event.tokenId} not found in database`,
        );
      }

      const beforeState = {
        tokenId: membership.tokenId,
        state: membership.state,
        expiresAt: membership.expiresAt?.toISOString(),
        renewedAt: membership.renewedAt?.toISOString(),
      };

      const newExpiresAt = new Date(event.newExpiresAt * 1000);
      const updatedMembership = await tx.membership.update({
        where: { id: membership.id },
        data: {
          expiresAt: newExpiresAt,
          renewedAt: new Date(),
        },
      });

      // Create audit event with on-chain metadata and hash-chain integrity
      await writeChainedAuditEvent(tx, {
        eventType: 'MEMBERSHIP_UPDATED',
        walletId: membership.member.wallet.address,
        communityId: membership.member.communityId,
        correlationId,
        chainId: event.chainId ?? null,
        txHash: txHash ?? null,
        blockNumber: event.blockNumber ?? null,
        logIndex: event.logIndex ?? null,
        beforeState,
        afterState: {
          tokenId: updatedMembership.tokenId,
          state: updatedMembership.state,
          expiresAt: updatedMembership.expiresAt?.toISOString(),
          renewedAt: updatedMembership.renewedAt?.toISOString(),
        },
      });

      // Create outbox event with on-chain metadata
      await tx.outboxEvent.create({
        data: {
          eventType: 'MEMBERSHIP_RENEWED',
          entityId: membership.id,
          entityType: 'Membership',
          communityId: membership.member.communityId,
          correlationId,
          chainId: event.chainId ?? null,
          txHash: txHash ?? null,
          blockNumber: event.blockNumber ?? null,
          logIndex: event.logIndex ?? null,
          payload: {
            memberId: membership.memberId,
            tokenId: event.tokenId,
            wallet: membership.member.wallet.address,
            newExpiresAt: newExpiresAt.toISOString(),
          },
          status: 'pending',
          nextRetryAt: new Date(),
        },
      });
    } else if (event.type === 'MembershipSuspended') {
      const membership = await tx.membership.findFirst({
        where: {
          tokenId: event.tokenId,
        },
        include: { member: { include: { wallet: true } } },
      });

      if (!membership) {
        throw new Error(
          `Cannot suspend membership: tokenId ${event.tokenId} not found in database`,
        );
      }

      const beforeState = {
        tokenId: membership.tokenId,
        state: membership.state,
        expiresAt: membership.expiresAt?.toISOString(),
      };

      const updatedMembership = await tx.membership.update({
        where: { id: membership.id },
        data: {
          state: event.isSuspended ? 'suspended' : 'active',
        },
      });

      // Create audit event with on-chain metadata and hash-chain integrity
      await writeChainedAuditEvent(tx, {
        eventType: 'MEMBERSHIP_UPDATED',
        walletId: membership.member.wallet.address,
        communityId: membership.member.communityId,
        correlationId,
        chainId: event.chainId ?? null,
        txHash: txHash ?? null,
        blockNumber: event.blockNumber ?? null,
        logIndex: event.logIndex ?? null,
        beforeState,
        afterState: {
          tokenId: updatedMembership.tokenId,
          state: updatedMembership.state,
          expiresAt: updatedMembership.expiresAt?.toISOString(),
        },
      });

      // Create outbox event with on-chain metadata
      await tx.outboxEvent.create({
        data: {
          eventType: event.isSuspended ? 'MEMBERSHIP_SUSPENDED' : 'MEMBERSHIP_UNSUSPENDED',
          entityId: membership.id,
          entityType: 'Membership',
          communityId: membership.member.communityId,
          correlationId,
          chainId: event.chainId ?? null,
          txHash: txHash ?? null,
          blockNumber: event.blockNumber ?? null,
          logIndex: event.logIndex ?? null,
          payload: {
            memberId: membership.memberId,
            tokenId: event.tokenId,
            wallet: membership.member.wallet.address,
            isSuspended: event.isSuspended,
          },
          status: 'pending',
          nextRetryAt: new Date(),
        },
      });
    }

    // Record the event as processed for reorg safety and idempotency.
    if (
      txHash &&
      event.logIndex !== undefined &&
      event.blockHash &&
      event.blockNumber !== undefined
    ) {
      await tx.processedEvent.create({
        data: {
          transactionHash: txHash,
          logIndex: event.logIndex,
          blockHash: event.blockHash,
          blockNumber: event.blockNumber,
          eventType: event.type,
        },
      });
    }
  });
}



/**
 * Apply multiple contract events in order
 *
 * Useful for replaying event history or batch processing.
 * Events are applied sequentially to maintain order guarantees.
 *
 * @param prisma - PrismaClient instance
 * @param events - Array of decoded contract events
 * @returns Number of events successfully applied
 */
export async function applyContractEvents(
  prisma: PrismaClient,
  events: DecodedContractEvent[],
): Promise<number> {
  let applied = 0;

  for (const event of events) {
    try {
      await applyContractEvent(prisma, event);
      applied++;
    } catch (error) {
      console.error(`Failed to apply event:`, event, error);
      throw error; // Re-throw to halt on first failure
    }
  }

  return applied;
}

/**
 * Get or create a community
 */
export async function ensureCommunity(
  prisma: PrismaClient,
  communityId: string,
  name?: string,
): Promise<{ id: string }> {
  return prisma.community.upsert({
    where: { id: communityId },
    update: {},
    create: {
      id: communityId,
      name: name || `${communityId} Community`,
    },
  });
}

/**
 * Get the current membership state for a wallet in a community
 *
 * Returns null if no membership exists.
 */
export async function getCurrentMembershipState(
  prisma: PrismaClient,
  wallet: string,
  communityId: string,
): Promise<{
  tokenId: number | null;
  state: string;
  expiresAt: Date | null;
} | null> {
  const member = await prisma.member.findFirst({
    where: {
      wallet: { address: wallet.toLowerCase() },
      community: { id: communityId },
    },
    include: { membership: true },
  });

  if (!member?.membership) {
    return null;
  }

  return {
    tokenId: member.membership.tokenId,
    state: member.membership.state,
    expiresAt: member.membership.expiresAt,
  };
}

/**
 * Check if a tokenId is already in use
 *
 * Useful for detecting duplicate events.
 */
export async function tokenIdExists(
  prisma: PrismaClient,
  tokenId: number,
): Promise<boolean> {
  const membership = await prisma.membership.findUnique({
    where: { tokenId },
  });
  return !!membership;
}
