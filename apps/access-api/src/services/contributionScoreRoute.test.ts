import { getScore, getScoreHistory } from './contributionService';

jest.mock('./prisma', () => ({
  getPrisma: jest.fn(),
}));

jest.mock('../lib/wallet', () => ({
  normalizeWalletAddress: (v: string) => v.toLowerCase(),
}));

function createMockPrisma(overrides: Record<string, any> = {}) {
  return {
    community: {
      findUnique: jest.fn().mockResolvedValue(
        overrides.community ?? { id: 'community-1', name: 'Test Community' },
      ),
    },
    contributionScore: {
      findUnique: jest.fn().mockResolvedValue(
        overrides.score !== undefined
          ? overrides.score
          : {
              totalScore: 30,
              breakdown: { tenure: 10, badge_count: 15, activity: 5 },
            },
      ),
    },
    contributionEvent: {
      findMany: jest.fn().mockResolvedValue(
        overrides.events ?? [
          {
            totalScore: 30,
            breakdown: { tenure: 10, badge_count: 15, activity: 5 },
            explanations: { tenure: '10 weeks', badge_count: '3 badges', activity: '5 events' },
            triggerEventId: 'evt-1',
            createdAt: new Date('2026-07-28T12:00:00Z'),
          },
        ],
      ),
    },
  } as any;
}

describe('contributionService — score retrieval', () => {
  describe('getScore', () => {
    it('should return persisted score', async () => {
      const prisma = createMockPrisma();
      const result = await getScore(prisma, '0xABC123', 'community-1');

      expect(result).not.toBeNull();
      expect(result!.total).toBe(30);
      expect(result!.breakdown).toEqual({ tenure: 10, badge_count: 15, activity: 5 });
    });

    it('should return null when no score exists', async () => {
      const prisma = createMockPrisma({ score: null });
      const result = await getScore(prisma, '0xabc123', 'community-1');

      expect(result).toBeNull();
    });

    it('should normalise wallet address', async () => {
      const prisma = createMockPrisma();
      await getScore(prisma, '0xABC123DEF', 'community-1');

      expect(prisma.contributionScore.findUnique).toHaveBeenCalledWith({
        where: {
          walletId_communityId: {
            walletId: '0xabc123def',
            communityId: 'community-1',
          },
        },
      });
    });
  });

  describe('getScoreHistory', () => {
    it('should return recent events', async () => {
      const prisma = createMockPrisma();
      const result = await getScoreHistory(prisma, '0xabc123', 'community-1');

      expect(result).toHaveLength(1);
      expect(result[0].totalScore).toBe(30);
      expect(result[0].triggerEventId).toBe('evt-1');
    });

    it('should return empty array when no events exist', async () => {
      const prisma = createMockPrisma({ events: [] });
      const result = await getScoreHistory(prisma, '0xabc123', 'community-1');

      expect(result).toEqual([]);
    });

    it('should respect limit parameter', async () => {
      const prisma = createMockPrisma();
      await getScoreHistory(prisma, '0xabc123', 'community-1', 5);

      expect(prisma.contributionEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it('should cap limit at 100', async () => {
      const prisma = createMockPrisma();
      await getScoreHistory(prisma, '0xabc123', 'community-1', 500);

      expect(prisma.contributionEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });
});
