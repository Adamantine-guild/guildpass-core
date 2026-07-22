process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/guildpass";
process.env.ACCESS_CHECK_RATE_LIMIT_IP_MAX = '5';
process.env.ACCESS_CHECK_RATE_LIMIT_WALLET_MAX = '3';
process.env.ACCESS_CHECK_RATE_LIMIT_WINDOW_MS = '60000';
process.env.RATE_LIMIT_ENABLED = 'true';

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

// Mock rate-limiter-flexible to simulate a Redis failure
jest.mock('rate-limiter-flexible', () => {
  return {
    RateLimiterRedis: jest.fn().mockImplementation(() => {
      return {
        consume: jest.fn().mockRejectedValue(new Error('Redis connection lost!')),
      };
    }),
    RateLimiterMemory: jest.fn().mockImplementation(() => {
      return {
        consume: jest.fn().mockRejectedValue(new Error('Memory failure simulated!')),
      };
    }),
  };
});

describe('POST /v1/access/check Rate Limiting Failure Modes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('fails open when Redis throws an error (default behavior)', async () => {
    process.env.ACCESS_CHECK_RATE_LIMIT_FAIL_OPEN = 'true';
    // Even if REDIS_URL is not set, we've mocked RateLimiterMemory to throw an error
    // to simulate the same failure path (e.g. database/memory down).
    
    app = await buildApp();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/access/check',
      payload: {
        wallet: '0x1234567890123456789012345678901234567890',
        communityId: 'comm-123',
        resource: 'resource-1'
      }
    });

    // Should fail open and return 200 OK
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.allowed).toBe(true);
  });

  it('fails closed when configured to do so', async () => {
    process.env.ACCESS_CHECK_RATE_LIMIT_FAIL_OPEN = 'false';
    
    app = await buildApp();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/access/check',
      payload: {
        wallet: '0x1234567890123456789012345678901234567890',
        communityId: 'comm-123',
        resource: 'resource-1'
      }
    });

    // Should fail closed and return 503
    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe('Service Unavailable');
    expect(body.message).toBe('Rate limiter unavailable');
  });
});
