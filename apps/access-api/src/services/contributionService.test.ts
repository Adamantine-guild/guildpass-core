import { recomputeAndPersist, getScore } from './contributionService';

function createMockPrisma(overrides: Record<string, any> = {}) {
  return {
    wallet: {
      findUnique: jest.fn().mockResolvedValue(
        overrides.wallet ?? { id: 'wallet-1', address: '0xabc123' },
      ),
    },
    member: {
      findFirst: jest.fn().mockResolvedValue(
        overrides.member ?? {
          id: 'member-1',
          walletId: 'wallet-1',
          communityId: 'community-1',
          createdAt: new Date(Date.now() - 10 * 7 * 24 * 60 * 60 * 1000),
          roles: [{ role: 'member', active: true }],
          badges: [{ id: 'b1' }, { id: 'b2' }],
        },
      ),
    },
    attendanceRecord: {
      count: jest.fn().mockResolvedValue(overrides.attendanceCount ?? 5),
    },
    contributionScore: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(
        overrides.score ?? {
          totalScore: 22,
          breakdown: { tenure: 10, badge_count: 12 },
        },
      ),
    },
  } as any;
}

describe('contributionService', () => {
  describe('recomputeAndPersist', () => {
    it('should compute and upsert score', async () => {
      const prisma = createMockPrisma();
      const result = await recomputeAndPersist(prisma, '0xABC123', 'community-1');

      expect(result.wallet).toBe('0xabc123');
      expect(result.communityId).toBe('community-1');
      expect(result.score.total).toBeGreaterThanOrEqual(0);
      expect(prisma.contributionScore.upsert).toHaveBeenCalledTimes(1);
    });

    it('should throw for unknown wallet', async () => {
      const prisma = createMockPrisma({ wallet: null });
      await expect(
        recomputeAndPersist(prisma, '0xunknown', 'community-1'),
      ).rejects.toThrow(/Wallet .* not found/);
    });

    it('should throw for unknown member', async () => {
      const prisma = createMockPrisma({ member: null });
      await expect(
        recomputeAndPersist(prisma, '0xabc123', 'community-1'),
      ).rejects.toThrow(/Member not found/);
    });
  });

  describe('getScore', () => {
    it('should return persisted score', async () => {
      const prisma = createMockPrisma();
      const result = await getScore(prisma, '0xabc123', 'community-1');

      expect(result).not.toBeNull();
      expect(result!.total).toBe(22);
      expect(result!.breakdown).toEqual({ tenure: 10, badge_count: 12 });
    });

    it('should return null when no score exists', async () => {
      const prisma = createMockPrisma({ score: null });
      const result = await getScore(prisma, '0xabc123', 'community-1');

      expect(result).toBeNull();
    });
  });
});
