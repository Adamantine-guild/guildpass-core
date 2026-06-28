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

/**
 * Decoded contract event types - derived from MembershipNFT.sol
 */

export interface DecodedMembershipMintedEvent {
  type: 'MembershipMinted';
  to: string; // wallet address
  tokenId: number;
  communityId: string;
  expiresAt: number; // unix timestamp
  blockNumber?: number;
  transactionHash?: string;
}

export interface DecodedMembershipRenewedEvent {
  type: 'MembershipRenewed';
  tokenId: number;
  newExpiresAt: number; // unix timestamp
  blockNumber?: number;
  transactionHash?: string;
}

export interface DecodedMembershipSuspendedEvent {
  type: 'MembershipSuspended';
  tokenId: number;
  isSuspended: boolean;
  blockNumber?: number;
  transactionHash?: string;
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
 * @param prisma - PrismaClient instance
 * @param event - Decoded contract event
 * @returns The updated or created membership record
 */
export async function applyContractEvent(
  prisma: PrismaClient,
  event: DecodedContractEvent,
): Promise<void> {
  validateEvent(event);

  // Access-affecting writes must be atomic.
  await prisma.$transaction(async (tx) => {
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

      // Create or update membership
      // Note: If a member receives a second MembershipMinted for the same community,
      // this updates their existing membership (replacing the tokenId and resetting state)
      await tx.membership.upsert({
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
    } else if (event.type === 'MembershipRenewed') {
      const membership = await tx.membership.findFirst({
        where: {
          tokenId: event.tokenId,
        },
      });

      if (!membership) {
        throw new Error(
          `Cannot renew membership: tokenId ${event.tokenId} not found in database`,
        );
      }

      const newExpiresAt = new Date(event.newExpiresAt * 1000);
      await tx.membership.update({
        where: { id: membership.id },
        data: {
          expiresAt: newExpiresAt,
          renewedAt: new Date(),
        },
      });
    } else if (event.type === 'MembershipSuspended') {
      const membership = await tx.membership.findFirst({
        where: {
          tokenId: event.tokenId,
        },
        include: { member: { select: { communityId: true } } },
      });

      if (!membership) {
        throw new Error(
          `Cannot suspend membership: tokenId ${event.tokenId} not found in database`,
        );
      }

      await tx.membership.update({
        where: { id: membership.id },
        data: {
          state: event.isSuspended ? 'suspended' : 'active',
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
