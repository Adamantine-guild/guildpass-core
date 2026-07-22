import { getStreakService } from '../src/services/streaks/streakService';
import { getRewardService } from '../src/services/rewards/rewardService';

// ---------------------------------------------------------------------------
// Mock Prisma Client
// ---------------------------------------------------------------------------

const mockPrisma: any = {
  streakState: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  rewardRule: {
    findMany: jest.fn(),
  },
  streakRewardHistory: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  member: {
    findFirst: jest.fn(),
  },
  badge: {
    create: jest.fn(),
  },
  roleAssignment: {
    findFirst: jest.fn(),
    create: jest.fn(),
  },
};

mockPrisma.$transaction = jest.fn((cb: any) => cb(mockPrisma));

jest.mock('../src/services/prisma', () => ({
  getPrisma: () => mockPrisma,
}));

describe('Streak & Reward Distribution Engine', () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const communityId = 'community-test';
  let streakService: ReturnType<typeof getStreakService>;
  let rewardService: ReturnType<typeof getRewardService>;

  beforeEach(() => {
    streakService = getStreakService(mockPrisma as any);
    rewardService = getRewardService(mockPrisma as any);
    jest.clearAllMocks();
  });

  describe('Streak Logic & Grace Periods', () => {
    test('should start a new streak on first activity', async () => {
      mockPrisma.streakState.findUnique.mockResolvedValue(null);
      mockPrisma.streakState.create.mockResolvedValue({
        currentStreak: 1,
        longestStreak: 1,
        graceUsed: false,
      });
      mockPrisma.rewardRule.findMany.mockResolvedValue([]);

      const activityTime = new Date('2026-07-01T12:00:00Z');
      const result = await streakService.recordActivity(wallet, communityId, activityTime);

      expect(mockPrisma.streakState.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          currentStreak: 1,
          longestStreak: 1,
          graceUsed: false,
        }),
      }));
      expect(result.currentStreak).toBe(1);
    });

    test('should not increment streak count on same-day activity', async () => {
      const lastActivity = new Date('2026-07-01T08:00:00Z');
      const nextActivity = new Date('2026-07-01T20:00:00Z');

      mockPrisma.streakState.findUnique.mockResolvedValue({
        id: 'streak-1',
        currentStreak: 5,
        longestStreak: 5,
        lastActivityAt: lastActivity,
        graceUsed: false,
      });
      mockPrisma.streakState.update.mockResolvedValue({
        currentStreak: 5,
      });
      mockPrisma.rewardRule.findMany.mockResolvedValue([]);

      const result = await streakService.recordActivity(wallet, communityId, nextActivity);

      expect(mockPrisma.streakState.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          lastActivityAt: nextActivity,
        }),
      }));
      expect(result.currentStreak).toBe(5);
    });

    test('should increment streak count on next-day activity', async () => {
      const lastActivity = new Date('2026-07-01T12:00:00Z');
      const nextActivity = new Date('2026-07-02T12:00:00Z');

      mockPrisma.streakState.findUnique.mockResolvedValue({
        id: 'streak-1',
        currentStreak: 5,
        longestStreak: 5,
        lastActivityAt: lastActivity,
        graceUsed: false,
      });
      mockPrisma.streakState.update.mockResolvedValue({
        currentStreak: 6,
      });
      mockPrisma.rewardRule.findMany.mockResolvedValue([]);

      const result = await streakService.recordActivity(wallet, communityId, nextActivity);

      expect(mockPrisma.streakState.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          currentStreak: 6,
          graceUsed: false,
        }),
      }));
    });

    test('should preserve and increment streak using grace period if exactly 1 day is missed', async () => {
      const lastActivity = new Date('2026-07-01T12:00:00Z');
      const nextActivity = new Date('2026-07-03T12:00:00Z'); // missed July 2nd

      mockPrisma.streakState.findUnique.mockResolvedValue({
        id: 'streak-1',
        currentStreak: 3,
        longestStreak: 3,
        lastActivityAt: lastActivity,
        graceUsed: false,
      });
      mockPrisma.streakState.update.mockResolvedValue({
        currentStreak: 4,
      });
      mockPrisma.rewardRule.findMany.mockResolvedValue([]);

      const result = await streakService.recordActivity(wallet, communityId, nextActivity);

      expect(mockPrisma.streakState.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          currentStreak: 4,
          graceUsed: true,
        }),
      }));
    });

    test('should break streak if grace period is already used and another day is missed', async () => {
      const lastActivity = new Date('2026-07-01T12:00:00Z');
      const nextActivity = new Date('2026-07-03T12:00:00Z');

      mockPrisma.streakState.findUnique.mockResolvedValue({
        id: 'streak-1',
        currentStreak: 3,
        longestStreak: 3,
        lastActivityAt: lastActivity,
        graceUsed: true, // Grace already used
      });
      mockPrisma.streakState.update.mockResolvedValue({
        currentStreak: 1,
      });
      mockPrisma.rewardRule.findMany.mockResolvedValue([]);

      const result = await streakService.recordActivity(wallet, communityId, nextActivity);

      expect(mockPrisma.streakState.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          currentStreak: 1,
          graceUsed: false,
        }),
      }));
    });
  });

  describe('Milestone Rewards & Idempotency', () => {
    test('should trigger badge grant and role upgrade and enforce idempotency', async () => {
      mockPrisma.rewardRule.findMany.mockResolvedValue([
        {
          id: 'rule-badge',
          communityId,
          milestone: 7,
          actionType: 'GRANT_BADGE',
          actionParams: { badgeLabel: '7-Day Champion' },
        },
        {
          id: 'rule-role',
          communityId,
          milestone: 7,
          actionType: 'UPGRADE_ROLE',
          actionParams: { role: 'contributor' },
        },
      ]);

      mockPrisma.member.findFirst.mockResolvedValue({ id: 'member-123' });
      mockPrisma.roleAssignment.findFirst.mockResolvedValue(null);

      // First evaluation: not awarded yet
      mockPrisma.streakRewardHistory.findUnique.mockResolvedValue(null);

      await rewardService.evaluateRewards(wallet, communityId, 7);

      expect(mockPrisma.badge.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ label: '7-Day Champion' }),
      }));
      expect(mockPrisma.roleAssignment.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ role: 'contributor' }),
      }));
      expect(mockPrisma.streakRewardHistory.create).toHaveBeenCalledTimes(2);

      // Reset mocks for idempotency test
      jest.clearAllMocks();

      // Second evaluation: mock database to show rewards are already awarded
      mockPrisma.streakRewardHistory.findUnique.mockResolvedValue({ id: 'history-entry' });

      await rewardService.evaluateRewards(wallet, communityId, 7);

      expect(mockPrisma.badge.create).not.toHaveBeenCalled();
      expect(mockPrisma.roleAssignment.create).not.toHaveBeenCalled();
    });
  });
});
