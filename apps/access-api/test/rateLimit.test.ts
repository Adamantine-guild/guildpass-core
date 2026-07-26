process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/guildpass";
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RATE_LIMIT_DEFAULT_MAX = '3';
process.env.RATE_LIMIT_EXPENSIVE_MAX = '1';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.TRUST_PROXY = 'true';
delete process.env.REDIS_URL;

import { buildApp } from '../src/app';
import { FastifyInstance } from 'fastify';

// Mock dependencies to avoid requiring a running db or external API services
jest.mock('../src/services/memberService', () => {
  return {
    getMemberService: jest.fn().mockReturnValue({
      getMembershipsByWallet: jest.fn().mockResolvedValue([]),
      listMembersForAdmin: jest.fn().mockResolvedValue({
        communityId: 'community-1',
        members: [],
        pagination: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        },
      }),
    }),
  };
});
jest.mock('../src/services/prisma', () => ({
  getPrisma: jest.fn().mockReturnValue({
    $queryRaw: jest.fn(),
    community: {
      findUnique: jest.fn().mockResolvedValue({ id: 'community-1' }),
    },
  }),
}));

describe('Global Rate Limiting against buildApp()', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows requests up to the default limit (3) on standard route', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/communities/community-1/memberships/0x0000000000000000000000000000000000000000',
        headers: {
          'x-forwarded-for': '1.2.3.4'
        }
      });
      expect(res.statusCode).toBe(200);
      expect(Number(res.headers['x-ratelimit-limit'])).toBe(3);
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    }

    const blocked = await app.inject({
      method: 'GET',
      url: '/v1/communities/community-1/memberships/0x0000000000000000000000000000000000000000',
      headers: {
        'x-forwarded-for': '1.2.3.4'
      }
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    const body = JSON.parse(blocked.payload);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toMatch(/Rate limit exceeded/);
  });

  it('enforces stricter limit (1) on expensive endpoint', async () => {
    const expensiveIp = '5.6.7.8';

    const res = await app.inject({
      method: 'GET',
      url: '/v1/communities/community-1/members',
      headers: {
        'x-forwarded-for': expensiveIp,
        'x-api-key': 'test-api-key',
      }
    });
    expect(res.statusCode).toBe(200);

    const blocked = await app.inject({
      method: 'GET',
      url: '/v1/communities/community-1/members',
      headers: {
        'x-forwarded-for': expensiveIp,
        'x-api-key': 'test-api-key',
      }
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('exempts health check route from rate limits', async () => {
    const healthIp = '9.10.11.12';
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: {
          'x-forwarded-for': healthIp
        }
      });
      expect(res.statusCode).toBe(200);
    }
  });
});
