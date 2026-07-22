/**
 * Contribution Service
 *
 * Bridges the @guildpass/contribution-engine package with the access-api's
 * Prisma data layer. Computes and persists contribution scores using the
 * pluggable signal-based scoring model.
 *
 * Designed for event-driven recomputation: the outbox handler calls
 * `recomputeAndPersist` whenever a relevant domain event arrives
 * (ROLE_ASSIGNED, BADGE_ASSIGNED, MEMBER_ATTENDED, MEMBERSHIP_CREATED, etc.).
 */

import type { PrismaClient } from '@prisma/client';
import {
  createDefaultEngine,
  type SignalContext,
  type ContributionScoreResult,
} from '@guildpass/contribution-engine';

const engine = createDefaultEngine();

function normaliseWallet(wallet: string): string {
  return wallet.toLowerCase();
}

export interface RecomputeResult {
  wallet: string;
  communityId: string;
  score: ContributionScoreResult;
}

/**
 * Build a SignalContext from Prisma data for the given wallet + community.
 */
async function buildSignalContext(
  prisma: PrismaClient,
  wallet: string,
  communityId: string,
): Promise<SignalContext> {
  const normalised = normaliseWallet(wallet);

  const walletRecord = await prisma.wallet.findUnique({
    where: { address: normalised },
  });

  if (!walletRecord) {
    throw new Error(`Wallet ${normalised} not found`);
  }

  const member = await prisma.member.findFirst({
    where: { walletId: walletRecord.id, communityId },
    include: {
      membership: {
        include: {
          activeToken: true,
        },
      },
      roles: true,
      badges: true,
    },
  });

  if (!member) {
    throw new Error(`Member not found for wallet ${normalised} in community ${communityId}`);
  }

  const joinedAt = member.createdAt;
  const badgeCount = member.badges.length;
  const roles = member.roles
    .filter((r) => r.active)
    .map((r) => r.role as string);

  const attendanceCount = await prisma.attendanceRecord.count({
    where: { walletId: normalised, communityId },
  });

  return {
    wallet: normalised,
    communityId,
    joinedAt,
    badgeCount,
    attendanceCount,
    roles,
  };
}

/**
 * Recompute the contribution score for a wallet/community pair and persist it.
 */
export async function recomputeAndPersist(
  prisma: PrismaClient,
  wallet: string,
  communityId: string,
): Promise<RecomputeResult> {
  const normalised = normaliseWallet(wallet);
  const ctx = await buildSignalContext(prisma, normalised, communityId);
  const score = engine.computeScore(ctx);

  await prisma.contributionScore.upsert({
    where: {
      walletId_communityId: {
        walletId: normalised,
        communityId,
      },
    },
    create: {
      walletId: normalised,
      communityId,
      totalScore: score.total,
      breakdown: score.breakdown,
    },
    update: {
      totalScore: score.total,
      breakdown: score.breakdown,
    },
  });

  return { wallet: normalised, communityId, score };
}

/**
 * Retrieve the persisted contribution score for a wallet/community pair.
 */
export async function getScore(
  prisma: PrismaClient,
  wallet: string,
  communityId: string,
): Promise<{ total: number; breakdown: Record<string, number> } | null> {
  const normalised = normaliseWallet(wallet);
  const record = await prisma.contributionScore.findUnique({
    where: {
      walletId_communityId: {
        walletId: normalised,
        communityId,
      },
    },
  });

  if (!record) return null;

  return {
    total: record.totalScore,
    breakdown: (record.breakdown as Record<string, number>) ?? {},
  };
}
