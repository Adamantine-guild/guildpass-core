process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/guildpass';

import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../src/routes';
import { queryAuditEvents } from '../src/services/auditService';

// Mock Prisma
const mockAuditEvents = [
  {
    id: 'ae-1',
    eventType: 'ACCESS_CHECK',
    walletId: '0x1111111111111111111111111111111111111111',
    communityId: 'community-1',
    resource: 'dashboard',
    policyRule: 'rule-1',
    decision: 'ALLOW',
    reasonCode: 'SUCCESS',
    beforeState: null,
    afterState: null,
    correlationId: 'corr-1',
    chainId: null,
    txHash: null,
    blockNumber: null,
    logIndex: null,
    membershipStateVersion: null,
    roleStateVersion: null,
    recordHash: 'hash-1',
    previousRecordHash: null,
    createdAt: new Date('2026-07-20T10:00:00Z'),
  },
  {
    id: 'ae-2',
    eventType: 'MEMBERSHIP_CREATED',
    walletId: '0x2222222222222222222222222222222222222222',
    communityId: 'community-1',
    resource: 'member',
    policyRule: null,
    decision: null,
    reasonCode: null,
    beforeState: null,
    afterState: null,
    correlationId: 'corr-2',
    chainId: null,
    txHash: null,
    blockNumber: null,
    logIndex: null,
    membershipStateVersion: null,
    roleStateVersion: null,
    recordHash: 'hash-2',
    previousRecordHash: 'hash-1',
    createdAt: new Date('2026-07-21T10:00:00Z'),
  },
];

const mockPrisma = {
  auditEvent: {
    findMany: jest.fn().mockImplementation((args) => {
      let filtered = [...mockAuditEvents];
      if (args?.where?.communityId) {
        filtered = filtered.filter((e) => e.communityId === args.where.communityId);
      }
      if (args?.where?.walletId) {
        const val = typeof args.where.walletId === 'object' ? args.where.walletId.equals : args.where.walletId;
        filtered = filtered.filter((e) => e.walletId.toLowerCase() === val.toLowerCase());
      }
      if (args?.where?.eventType) {
        filtered = filtered.filter((e) => e.eventType === args.where.eventType);
      }
      if (args?.where?.resource) {
        filtered = filtered.filter((e) => e.resource === args.where.resource);
      }
      if (args?.where?.createdAt?.gte) {
        filtered = filtered.filter((e) => e.createdAt >= args.where.createdAt.gte);
      }
      if (args?.where?.createdAt?.lte) {
        filtered = filtered.filter((e) => e.createdAt <= args.where.createdAt.lte);
      }
      const skip = args?.skip ?? 0;
      const take = args?.take ?? filtered.length;
      return Promise.resolve(filtered.slice(skip, skip + take));
    }),
    count: jest.fn().mockImplementation((args) => {
      let filtered = [...mockAuditEvents];
      if (args?.where?.communityId) {
        filtered = filtered.filter((e) => e.communityId === args.where.communityId);
      }
      if (args?.where?.walletId) {
        const val = typeof args.where.walletId === 'object' ? args.where.walletId.equals : args.where.walletId;
        filtered = filtered.filter((e) => e.walletId.toLowerCase() === val.toLowerCase());
      }
      if (args?.where?.eventType) {
        filtered = filtered.filter((e) => e.eventType === args.where.eventType);
      }
      if (args?.where?.resource) {
        filtered = filtered.filter((e) => e.resource === args.where.resource);
      }
      if (args?.where?.createdAt?.gte) {
        filtered = filtered.filter((e) => e.createdAt >= args.where.createdAt.gte);
      }
      if (args?.where?.createdAt?.lte) {
        filtered = filtered.filter((e) => e.createdAt <= args.where.createdAt.lte);
      }
      return Promise.resolve(filtered.length);
    }),
  },
  member: {
    findMany: jest.fn().mockResolvedValue([
      {
        wallet: { address: '0xadmin00000000000000000000000000000000000' },
        roles: [{ role: 'admin', active: true }],
      },
    ]),
  },
  community: {
    findUnique: jest.fn().mockResolvedValue({ id: 'community-1' }),
  },
  $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
};

jest.mock('../src/services/prisma', () => ({
  getPrisma: () => mockPrisma,
}));

describe('Audit Events Service & Route Tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await registerRoutes(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('queryAuditEvents Service', () => {
    test('queries events with pagination', async () => {
      const result = await queryAuditEvents(mockPrisma as any, {
        communityId: 'community-1',
        page: 1,
        limit: 1,
      });

      expect(result.pagination).toEqual({
        page: 1,
        limit: 1,
        total: 2,
        totalPages: 2,
      });
      expect(result.events).toHaveLength(1);
    });

    test('filters by actorWallet, eventType, and resource', async () => {
      const result = await queryAuditEvents(mockPrisma as any, {
        communityId: 'community-1',
        actorWallet: '0x1111111111111111111111111111111111111111',
        eventType: 'ACCESS_CHECK',
        resource: 'dashboard',
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe('ae-1');
    });

    test('filters by date range (from/to)', async () => {
      const result = await queryAuditEvents(mockPrisma as any, {
        communityId: 'community-1',
        from: new Date('2026-07-21T00:00:00Z'),
        to: new Date('2026-07-22T00:00:00Z'),
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe('ae-2');
    });
  });

  describe('GET /v1/communities/:communityId/audit-events Route', () => {
    test('returns 401 Unauthorized when API key is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/communities/community-1/audit-events',
      });

      expect(response.statusCode).toBe(401);
    });

    test('returns 403 Forbidden when requester is not community admin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/communities/community-1/audit-events',
        headers: {
          'x-api-key': 'test-api-key',
          'x-wallet': '0xnonadmin00000000000000000000000000000000',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    test('returns 200 OK with paginated audit events for valid admin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/communities/community-1/audit-events?page=1&limit=10',
        headers: {
          'x-api-key': 'test-api-key',
          'x-wallet': '0xadmin00000000000000000000000000000000000',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.events).toHaveLength(2);
      expect(body.pagination).toBeDefined();
      expect(body.pagination.total).toBe(2);
    });

    test('returns 400 Bad Request for invalid date query param', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/communities/community-1/audit-events?from=invalid-date',
        headers: {
          'x-api-key': 'test-api-key',
          'x-wallet': '0xadmin00000000000000000000000000000000000',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
