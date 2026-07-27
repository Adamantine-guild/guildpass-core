import type { MembershipState } from '@guildpass/shared-types';
import { PrismaClient } from '@prisma/client';
import { InMemoryCacheService } from './cacheService';

const mockCache = new InMemoryCacheService();

// Mock config to enable cache in this test suite
jest.mock('../config', () => ({
  config: {
    accessDecisionCacheEnabled: true,
    accessDecisionCacheTtlSeconds: 30,
    accessDecisionCacheVersionTtlSeconds: 86400,
    redisUrl: 'mock-redis-url',
  },
}));

// Mock redisCacheService to return our shared InMemoryCacheService
jest.mock('./redisCacheService', () => ({
  createDefaultCacheService: (enabled: boolean) => {
    return enabled ? mockCache : new (require('./cacheService').NoopCacheService)();
  },
}));

import { getMemberService } from './memberService';

// Mock Prisma client
const mockPrisma = {
  wallet: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  linkedWallet: {
    findFirst: jest.fn().mockResolvedValue(null),
  },
  roleDefinition: {
    findMany: jest.fn(),
  },
  delegatedGrant: {
    findMany: jest.fn(),
  },
  member: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  accessPolicy: {
    findFirst: jest.fn(),
  },
  community: {
    findUnique: jest.fn(),
  },
  roleAssignment: {
    findFirst: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  accessOverride: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  badge: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  },
  outboxEvent: {
    create: jest.fn(),
  },
  auditEvent: {
    create: jest.fn(),
  },
  governanceRule: {
    findMany: jest.fn(),
  },
  contributionScore: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn((callback) => callback(mockPrisma)),
} as unknown as PrismaClient;

describe('MemberService - Concurrency & Cache Consistency Tests', () => {
  let memberService: ReturnType<typeof getMemberService>;
  let setJSONSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    // Re-create/clear the in-memory cache stores
    // Since mockCache is a singleton, we can delete keys or reset it
    (mockCache as any).store.clear();
    (mockCache as any).incrStore.clear();

    setJSONSpy = jest.spyOn(mockCache, 'setJSON');

    // Default mocks for checkAccess
    (mockPrisma.wallet.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.wallet.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.linkedWallet.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.member.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.member.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.accessPolicy.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.community.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.roleAssignment.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.roleAssignment.create as jest.Mock).mockResolvedValue({});
    (mockPrisma.roleAssignment.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.accessOverride.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.accessOverride.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.governanceRule.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.contributionScore.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.roleDefinition.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.delegatedGrant.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.outboxEvent.create as jest.Mock).mockResolvedValue({ id: 'outbox-event-id' });
    (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({ id: 'audit-event-id' });

    memberService = getMemberService(mockPrisma);
  });

  it('should skip cache write when a version bump occurs mid-flight (optimistic concurrency check)', async () => {
    const communityId = 'community-1';
    const wallet = '0x1234567890abcdef';
    const resource = 'resource-1';

    const mockWallet = { id: 'wallet-1', address: wallet.toLowerCase() };
    const mockMember = {
      communityId,
      walletId: 'wallet-1',
      membership: {
        state: 'active' as MembershipState,
        expiresAt: null,
      },
      roles: [],
    };

    (mockPrisma.wallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);
    (mockPrisma.wallet.findMany as jest.Mock).mockResolvedValue([mockWallet]);
    (mockPrisma.member.findMany as jest.Mock).mockResolvedValue([mockMember]);
    (mockPrisma.member.findFirst as jest.Mock).mockResolvedValue(mockMember);

    // Mock policy lookup. We intercept this query to simulate a concurrent mutation bump.
    (mockPrisma.accessPolicy.findFirst as jest.Mock).mockImplementation(async () => {
      // Simulate concurrent mutation bump to membership version
      await mockCache.incr(`accessDecisionVersion:membership|c:${communityId}`);
      return {
        id: 'policy-1',
        communityId,
        resource,
        ruleType: 'PUBLIC',
        params: {},
      };
    });

    const result = await memberService.checkAccess({
      wallet,
      communityId,
      resource,
    });

    // The decision should still be computed and returned successfully to the caller
    expect(result.allowed).toBe(true);

    // BUT the cache write must be skipped entirely because the version changed mid-flight!
    // Under the old code (without the optimistic concurrency check), the checkAccess call
    // would have successfully written the computed decision to the cache. Next time the user
    // requested access for the new version, they might get served a decision computed against
    // stale data, violating cache consistency. With the fix, the mismatch between the read-time
    // snapshot and the pre-write check is detected, and the cache write is skipped.
    expect(setJSONSpy).not.toHaveBeenCalled();

    // Verify cache is empty for this key
    const cachedVal = await mockCache.getJSON(
      // key based on the initial version snapshot (all nulls/zeros initially)
      `accessDecision|c:${communityId}|w:${wallet.toLowerCase()}|r:${resource}|mv:0|rv:0|pv:0|rsv:0|ov:0|dv:0`
    );
    expect(cachedVal).toBeNull();
  });

  it('should not regression hit rate under normal sequential calls (no concurrency race)', async () => {
    const communityId = 'community-1';
    const wallet = '0x1234567890abcdef';
    const resource = 'resource-1';

    const mockWallet = { id: 'wallet-1', address: wallet.toLowerCase() };
    const mockMember = {
      communityId,
      walletId: 'wallet-1',
      membership: {
        state: 'active' as MembershipState,
        expiresAt: null,
      },
      roles: [],
    };

    (mockPrisma.wallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);
    (mockPrisma.wallet.findMany as jest.Mock).mockResolvedValue([mockWallet]);
    (mockPrisma.member.findMany as jest.Mock).mockResolvedValue([mockMember]);
    (mockPrisma.member.findFirst as jest.Mock).mockResolvedValue(mockMember);

    (mockPrisma.accessPolicy.findFirst as jest.Mock).mockResolvedValue({
      id: 'policy-1',
      communityId,
      resource,
      ruleType: 'PUBLIC',
      params: {},
    });

    // Reset spy count before the sequential check
    setJSONSpy.mockClear();

    // First call: cache miss, computes and writes to cache
    const result1 = await memberService.checkAccess({
      wallet,
      communityId,
      resource,
    });
    expect(result1.allowed).toBe(true);
    expect(setJSONSpy).toHaveBeenCalledTimes(1);

    // Second call: cache hit, serves from cache without hitting Prisma again
    (mockPrisma.accessPolicy.findFirst as jest.Mock).mockClear();
    const result2 = await memberService.checkAccess({
      wallet,
      communityId,
      resource,
    });
    expect(result2.allowed).toBe(true);
    expect(mockPrisma.accessPolicy.findFirst).not.toHaveBeenCalled();
  });
});
