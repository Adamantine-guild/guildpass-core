import { PrismaClient } from '@prisma/client';

export function getRewardService(prisma: PrismaClient) {
  /**
   * Evaluate milestone reward rules for a user based on their current streak
   */
  async function evaluateRewards(walletAddress: string, communityId: string, currentStreak: number) {
    const normalisedWallet = walletAddress.toLowerCase();

    // Fetch rules applicable to this milestone
    const rules = await prisma.rewardRule.findMany({
      where: {
        communityId,
        milestone: { lte: currentStreak },
      },
    });

    for (const rule of rules) {
      // Check if already awarded (fast path check)
      const alreadyAwarded = await prisma.streakRewardHistory.findUnique({
        where: {
          walletId_communityId_ruleId: {
            walletId: normalisedWallet,
            communityId,
            ruleId: rule.id,
          },
        },
      });

      if (alreadyAwarded) continue;

      // Apply reward in transaction for safety
      await prisma.$transaction(async (tx) => {
        // Double-check under transaction lock
        const lockedHistory = await tx.streakRewardHistory.findUnique({
          where: {
            walletId_communityId_ruleId: {
              walletId: normalisedWallet,
              communityId,
              ruleId: rule.id,
            },
          },
        });

        if (lockedHistory) return;

        const params = rule.actionParams as any;

        // Find member
        const member = await tx.member.findFirst({
          where: {
            communityId,
            wallet: { address: normalisedWallet },
          },
        });

        if (!member) return;

        if (rule.actionType === 'GRANT_BADGE') {
          await tx.badge.create({
            data: {
              memberId: member.id,
              label: params.badgeLabel || 'Streak Milestone Reward',
            },
          });
        } else if (rule.actionType === 'UPGRADE_ROLE') {
          // Check if they already have this role assignment
          const existingRole = await tx.roleAssignment.findFirst({
            where: {
              memberId: member.id,
              role: params.role,
            },
          });

          if (!existingRole) {
            await tx.roleAssignment.create({
              data: {
                memberId: member.id,
                role: params.role,
                source: 'auto',
                active: true,
              },
            });
          }
        }

        // Record reward history
        await tx.streakRewardHistory.create({
          data: {
            walletId: normalisedWallet,
            communityId,
            ruleId: rule.id,
          },
        });
      });
    }
  }

  return {
    evaluateRewards,
  };
}
