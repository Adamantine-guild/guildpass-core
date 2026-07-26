process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/guildpass";
process.env.ACCESS_CHECK_RATE_LIMIT_IP_MAX = '2';
process.env.ACCESS_CHECK_RATE_LIMIT_WALLET_MAX = '50';
process.env.ACCESS_CHECK_RATE_LIMIT_WINDOW_MS = '60000';
process.env.RATE_LIMIT_ENABLED = 'true';
// Exposed directly: X-Forwarded-For must not be honoured when deriving the
// client IP, otherwise the per-IP budget can be reset at will by the caller.
process.env.TRUST_PROXY = 'false';
delete process.env.REDIS_URL;

import { buildApp } from '../src/app';
import { FastifyInstance } from 'fastify';

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

const WINDOW_MS = 60_000;

function accessCheck(
  app: FastifyInstance,
  headers: Record<string, string>,
  wallet: string,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/access/check',
    headers,
    payload: { wallet, communityId: 'comm-123', resource: 'resource-1' },
  });
}

describe('POST /v1/access/check rate limit hardening', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('emits Retry-After in RFC 9110 delta-seconds, not milliseconds', async () => {
    const headers = { 'x-api-key': 'retry-after-unit-key' };

    let throttled;
    for (let i = 0; i < 3; i++) {
      throttled = await accessCheck(
        app,
        headers,
        `0x00000000000000000000000000000000000000a${i}`,
      );
    }

    expect(throttled!.statusCode).toBe(429);

    const retryAfter = throttled!.headers['retry-after'];
    expect(retryAfter).toBeDefined();

    const seconds = Number(retryAfter);
    expect(Number.isNaN(seconds)).toBe(false);
    expect(Number.isInteger(seconds)).toBe(true);

    // The window is 60000 ms. A delta-seconds header must never exceed the
    // window expressed in seconds; emitting the raw millisecond value here
    // would hand SDK clients ~60000 s (~16.6 h) of backoff, because
    // guildpass-sdk's getRetryAfterMs() multiplies this value by 1000 and
    // feeds it straight to its token bucket without clamping.
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(WINDOW_MS / 1000);
  });

  it('isolates budgets per API key so a shared egress IP is not one bucket', async () => {
    const noisyNeighbour = { 'x-api-key': 'integration-a' };
    const wellBehaved = { 'x-api-key': 'integration-b' };

    // Exhaust the first integration's budget (max 2, so the third is throttled).
    for (let i = 0; i < 2; i++) {
      const ok = await accessCheck(
        app,
        noisyNeighbour,
        `0x00000000000000000000000000000000000000b${i}`,
      );
      expect(ok.statusCode).toBe(200);
    }
    const throttled = await accessCheck(
      app,
      noisyNeighbour,
      '0x00000000000000000000000000000000000000bf',
    );
    expect(throttled.statusCode).toBe(429);

    // A different API key arriving from the same address is unaffected.
    const neighbourStillServed = await accessCheck(
      app,
      wellBehaved,
      '0x00000000000000000000000000000000000000c0',
    );
    expect(neighbourStillServed.statusCode).toBe(200);
  });

  it('does not let an untrusted X-Forwarded-For mint a fresh IP bucket', async () => {
    // No API key: the limiter falls back to keying on request.ip.
    for (let i = 0; i < 2; i++) {
      const ok = await accessCheck(
        app,
        { 'x-forwarded-for': `203.0.113.${i}` },
        `0x00000000000000000000000000000000000000d${i}`,
      );
      expect(ok.statusCode).toBe(200);
    }

    // A brand-new spoofed address must not reset the budget: with TRUST_PROXY
    // off, Fastify ignores the header and request.ip stays the socket address.
    const spoofed = await accessCheck(
      app,
      { 'x-forwarded-for': '198.51.100.77' },
      '0x00000000000000000000000000000000000000df',
    );
    expect(spoofed.statusCode).toBe(429);
  });
});
