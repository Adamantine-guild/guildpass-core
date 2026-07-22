process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/guildpass";
process.env.ACCESS_CHECK_RATE_LIMIT_IP_MAX = '5';
process.env.ACCESS_CHECK_RATE_LIMIT_WALLET_MAX = '3';
process.env.ACCESS_CHECK_RATE_LIMIT_WINDOW_MS = '60000';
process.env.RATE_LIMIT_ENABLED = 'true';
delete process.env.REDIS_URL;

import { buildApp } from '../src/app';
import { FastifyInstance } from 'fastify';

// Mock dependencies
jest.mock('../src/services/memberService', () => {
  return {
    getMemberService: jest.fn().mockReturnValue({
      checkAccess: jest.fn().mockResolvedValue({ allowed: true, code: 'ALLOW', reasons: [] }),
    }),
  };
});
jest.mock('../src/services/prisma', () => ({
  getPrisma: jest.fn().mockReturnValue({
    $queryRaw: jest.fn(),
  }),
}));

describe('POST /v1/access/check Rate Limiting', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Configure rate limits for the test environment
    process.env.ACCESS_CHECK_RATE_LIMIT_IP_MAX = '5';
    process.env.ACCESS_CHECK_RATE_LIMIT_WALLET_MAX = '3';
    process.env.ACCESS_CHECK_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.RATE_LIMIT_ENABLED = 'true';
    
    // Unset redis url to use memory fallback during tests to avoid real dependency
    delete process.env.REDIS_URL;

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('enforces IP-based rate limiting (max 5)', async () => {
    const promises = [];
    const ip = '192.168.1.100';
    for (let i = 0; i < 6; i++) {
      promises.push(
        app.inject({
          method: 'POST',
          url: '/v1/access/check',
          headers: {
            'x-forwarded-for': ip,
          },
          payload: {
            wallet: `0x000000000000000000000000000000000000000${i}`, // distinct wallets
            communityId: 'comm-123',
            resource: 'resource-1'
          }
        })
      );
    }
    
    const responses = await Promise.all(promises);
    
    // First 5 should succeed (200)
    for (let i = 0; i < 5; i++) {
      expect(responses[i].statusCode).toBe(200);
    }

    // 6th should fail (429)
    const lastResponse = responses[5];
    expect(lastResponse.statusCode).toBe(429);
    expect(lastResponse.headers['retry-after']).toBeDefined();
    
    const body = JSON.parse(lastResponse.payload);
    expect(body.error).toBe('Too Many Requests');
    expect(body.message).toMatch(/Rate limit exceeded\. Retry after \d+ seconds\./);
  });

  it('enforces Wallet-based rate limiting (max 3)', async () => {
    const promises = [];
    const wallet = '0x1111111111111111111111111111111111111111';
    for (let i = 0; i < 4; i++) {
      promises.push(
        app.inject({
          method: 'POST',
          url: '/v1/access/check',
          headers: {
            'x-forwarded-for': `10.0.0.${i}`, // distinct IPs
          },
          payload: {
            wallet,
            communityId: 'comm-123',
            resource: 'resource-1'
          }
        })
      );
    }
    
    const responses = await Promise.all(promises);
    
    // First 3 should succeed
    for (let i = 0; i < 3; i++) {
      expect(responses[i].statusCode).toBe(200);
    }

    // 4th should fail
    const lastResponse = responses[3];
    expect(lastResponse.statusCode).toBe(429);
    expect(lastResponse.headers['retry-after']).toBeDefined();
  });
});
