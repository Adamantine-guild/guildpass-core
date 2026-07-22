/**
 * Contract Event Processing Helpers
 *
 * This module provides utilities for decoding and applying MembershipNFT contract events
 * to the database. It serves both as a foundation for event indexer implementation and
 * as a test helper for integration tests.
 *
 * These helpers bridge the gap between contract events and database state updates.
 *
 * Event types are imported from @guildpass/contracts — the single source of truth
 * for the MembershipNFT contract ABI and typed event definitions.
 */

import type { PrismaClient } from '@prisma/client';
import { writeChainedAuditEvent } from './auditChainHasher';

// Re-export event types from the shared contracts package so that existing
// consumers of this module continue to work without import changes.
export type {
  DecodedContractEvent,
  DecodedMembershipMintedEvent,
  DecodedMembershipRenewedEvent,
  DecodedMembershipSuspendedEvent,
} from '@guildpass/contracts';

import type {
  DecodedContractEvent,
  DecodedMembershipMintedEvent,
  DecodedMembershipRenewedEvent,
  DecodedMembershipSuspendedEvent,
} from '@guildpass/contracts';

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
        include: { activeToken: true },
      });
      const previousToken = existingMembership?.activeToken;

      // Create or update membership token
      const updatedToken = await tx.membershipToken.upsert({
        where: { tokenId: event.tokenId },
        update: {
          memberId: member.id,
          state: 'active',
          expiresAt,
          renewedAt: new Date(),
        },
        create: {
          tokenId: event.tokenId,
          memberId: member.id,
          state: 'active',
          expiresAt,
        },
      });

      // Update the active token pointer in Membership table
      const updatedMembership = await tx.membership.upsert({
        where: { memberId: member.id },
        update: {
          activeTokenId: event.tokenId,
        },
        create: {
          memberId: member.id,
          activeTokenId: event.tokenId,
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
        beforeState: (previousToken ? {
          tokenId: previousToken.tokenId,
          state: previousToken.state,
          expiresAt: previousToken.expiresAt?.toISOString(),
        } : null) as any,
        afterState: {
          tokenId: updatedToken.tokenId,
          state: updatedToken.state,
          expiresAt: updatedToken.expiresAt?.toISOString(),
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
      const token = await tx.membershipToken.findUnique({
        where: {
          tokenId: event.tokenId,
        },
        include: {
          member: {
            include: {
              wallet: true,
              membership: true,
            },
          },
        },
      });

      if (!token) {
        throw new Error(
          `Cannot renew membership: tokenId ${event.tokenId} not found in database`,
        );
      }

      const beforeState = {
        tokenId: token.tokenId,
        state: token.state,
        expiresAt: token.expiresAt?.toISOString(),
        renewedAt: token.renewedAt?.toISOString(),
      };

      const newExpiresAt = new Date(event.newExpiresAt * 1000);
      const updatedToken = await tx.membershipToken.update({
        where: { tokenId: token.tokenId },
        data: {
          expiresAt: newExpiresAt,
          renewedAt: new Date(),
        },
      });

      // Create audit event with on-chain metadata and hash-chain integrity
      await writeChainedAuditEvent(tx, {
        eventType: 'MEMBERSHIP_UPDATED',
        walletId: token.member.wallet.address,
        communityId: token.member.communityId,
        correlationId,
        chainId: event.chainId ?? null,
        txHash: txHash ?? null,
        blockNumber: event.blockNumber ?? null,
        logIndex: event.logIndex ?? null,
        beforeState,
        afterState: {
          tokenId: updatedToken.tokenId,
          state: updatedToken.state,
          expiresAt: updatedToken.expiresAt?.toISOString(),
          renewedAt: updatedToken.renewedAt?.toISOString(),
        },
      });

      // Create outbox event with on-chain metadata
      await tx.outboxEvent.create({
        data: {
          eventType: 'MEMBERSHIP_RENEWED',
          entityId: token.member.membership?.id ?? 'unknown',
          entityType: 'Membership',
          communityId: token.member.communityId,
          correlationId,
          chainId: event.chainId ?? null,
          txHash: txHash ?? null,
          blockNumber: event.blockNumber ?? null,
          logIndex: event.logIndex ?? null,
          payload: {
            memberId: token.memberId,
            tokenId: event.tokenId,
            wallet: token.member.wallet.address,
            newExpiresAt: newExpiresAt.toISOString(),
          },
          status: 'pending',
          nextRetryAt: new Date(),
        },
      });
    } else if (event.type === 'MembershipSuspended') {
      const token = await tx.membershipToken.findUnique({
        where: {
          tokenId: event.tokenId,
        },
        include: {
          member: {
            include: {
              wallet: true,
              membership: true,
            },
          },
        },
      });

      if (!token) {
        throw new Error(
          `Cannot suspend membership: tokenId ${event.tokenId} not found in database`,
        );
      }

      const beforeState = {
        tokenId: token.tokenId,
        state: token.state,
        expiresAt: token.expiresAt?.toISOString(),
      };

      const updatedToken = await tx.membershipToken.update({
        where: { tokenId: token.tokenId },
        data: {
          state: event.isSuspended ? 'suspended' : 'active',
        },
      });

      // Create audit event with on-chain metadata and hash-chain integrity
      await writeChainedAuditEvent(tx, {
        eventType: 'MEMBERSHIP_UPDATED',
        walletId: token.member.wallet.address,
        communityId: token.member.communityId,
        correlationId,
        chainId: event.chainId ?? null,
        txHash: txHash ?? null,
        blockNumber: event.blockNumber ?? null,
        logIndex: event.logIndex ?? null,
        beforeState,
        afterState: {
          tokenId: updatedToken.tokenId,
          state: updatedToken.state,
          expiresAt: updatedToken.expiresAt?.toISOString(),
        },
      });

      // Create outbox event with on-chain metadata
      await tx.outboxEvent.create({
        data: {
          eventType: event.isSuspended ? 'MEMBERSHIP_SUSPENDED' : 'MEMBERSHIP_UNSUSPENDED',
          entityId: token.member.membership?.id ?? 'unknown',
          entityType: 'Membership',
          communityId: token.member.communityId,
          correlationId,
          chainId: event.chainId ?? null,
          txHash: txHash ?? null,
          blockNumber: event.blockNumber ?? null,
          logIndex: event.logIndex ?? null,
          payload: {
            memberId: token.memberId,
            tokenId: event.tokenId,
            wallet: token.member.wallet.address,
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
    include: {
      membership: {
        include: {
          activeToken: true,
        },
      },
    },
  });

  if (!member?.membership?.activeToken) {
    return null;
  }

  return {
    tokenId: member.membership.activeToken.tokenId,
    state: member.membership.activeToken.state,
    expiresAt: member.membership.activeToken.expiresAt,
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
  const token = await prisma.membershipToken.findUnique({
    where: { tokenId },
  });
  return !!token;
}
