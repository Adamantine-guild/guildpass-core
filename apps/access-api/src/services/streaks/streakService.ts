import { PrismaClient } from '@prisma/client';
import { getRewardService } from '../rewards/rewardService';

export function getDaysDifference(d1: Date, d2: Date): number {
  const utc1 = Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate());
  const utc2 = Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate());
  return Math.floor((utc2 - utc1) / (1000 * 60 * 60 * 24));
}

export function getStreakService(prisma: PrismaClient) {
  const rewardService = getRewardService(prisma);

  /**
   * Record wallet activity for a community and recalculate streaks.
   * Grace periods allow exactly 1 missed day without breaking the streak.
   */
  async function recordActivity(walletAddress: string, communityId: string, activityTime: Date = new Date()) {
    const normalisedWallet = walletAddress.toLowerCase();

    return prisma.$transaction(async (tx) => {
      const streakState = await tx.streakState.findUnique({
        where: {
          walletId_communityId: {
            walletId: normalisedWallet,
            communityId,
          },
        },
      });

      if (!streakState) {
        // First activity record
        const newStreak = await tx.streakState.create({
          data: {
            walletId: normalisedWallet,
            communityId,
            currentStreak: 1,
            longestStreak: 1,
            lastActivityAt: activityTime,
            graceUsed: false,
          },
        });

        await rewardService.evaluateRewards(normalisedWallet, communityId, 1);
        return newStreak;
      }

      const daysDiff = getDaysDifference(new Date(streakState.lastActivityAt), activityTime);

      if (daysDiff <= 0) {
        // Same day or historical activity: update timestamp if newer, but keep count unchanged
        let updatedTime = streakState.lastActivityAt;
        if (activityTime > new Date(streakState.lastActivityAt)) {
          updatedTime = activityTime;
        }

        const updatedStreak = await tx.streakState.update({
          where: { id: streakState.id },
          data: { lastActivityAt: updatedTime },
        });

        await rewardService.evaluateRewards(normalisedWallet, communityId, updatedStreak.currentStreak);
        return updatedStreak;
      }

      let currentStreak = streakState.currentStreak;
      let graceUsed = streakState.graceUsed;

      if (daysDiff === 1) {
        // Consecutive day
        currentStreak++;
        graceUsed = false; // Reset grace used when returning to consecutive streak
      } else if (daysDiff === 2) {
        // Grace period (missed exactly 1 day)
        if (!graceUsed) {
          graceUsed = true;
          currentStreak++; // Preserve and increment streak count
        } else {
          // Grace already used, streak breaks
          currentStreak = 1;
          graceUsed = false;
        }
      } else {
        // Missed > 1 day: streak breaks
        currentStreak = 1;
        graceUsed = false;
      }

      const longestStreak = Math.max(currentStreak, streakState.longestStreak);

      const updatedStreak = await tx.streakState.update({
        where: { id: streakState.id },
        data: {
          currentStreak,
          longestStreak,
          lastActivityAt: activityTime,
          graceUsed,
        },
      });

      await rewardService.evaluateRewards(normalisedWallet, communityId, currentStreak);
      return updatedStreak;
    });
  }

  return {
    recordActivity,
  };
}
