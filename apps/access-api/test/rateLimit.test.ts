import Fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

interface RateLimitOptions {
  enabled: boolean;
  max: number;
  expensiveMax: number;
  timeWindow: number;
}

async function buildRateLimitedApp(opts: RateLimitOptions): Promise<FastifyInstance> {
  const app = Fastify();

  if (opts.enabled) {
    await app.register(rateLimit, {
      global: true,
      max: opts.max,
      timeWindow: opts.timeWindow,
      errorResponseBuilder: (_req, context) => ({
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Retry after ${Math.ceil(context.ttl / 1000)} seconds.`,
        retryAfter: Math.ceil(context.ttl / 1000),
      }),
      addHeaders: {
        'x-ratelimit-limit': true,
        'x-ratelimit-remaining': true,
        'x-ratelimit-reset': true,
        'retry-after': true,
      },
    });
  }

  app.get('/health/live', { config: { rateLimit: false } }, async () => {
    return { status: 'ok' };
  });

  app.get('/v1/access/check', async () => {
    return { allowed: true };
  });

  app.get('/v1/communities/:communityId/members', {
    config: {
      rateLimit: opts.enabled
        ? { max: opts.expensiveMax, timeWindow: opts.timeWindow }
        : false,
    },
  }, async () => {
    return { members: [] };
  });

  await app.ready();
  return app;
}

describe('Rate limiting — allowed requests', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildRateLimitedApp({
      enabled: true,
      max: 5,
      expensiveMax: 2,
      timeWindow: 60_000,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows requests up to the configured limit', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/access/check' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('attaches rate limit headers to responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/access/check' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });
});

describe('Rate limiting — blocked requests', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildRateLimitedApp({
      enabled: true,
      max: 3,
      expensiveMax: 2,
      timeWindow: 60_000,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 429 after the limit is exceeded', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/access/check' });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({ method: 'GET', url: '/v1/access/check' });
    expect(blocked.statusCode).toBe(429);
  });

  it('returns a JSON body with error and retryAfter on 429', async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'GET', url: '/v1/access/check' });
    }

    const blocked = await app.inject({ method: 'GET', url: '/v1/access/check' });
    expect(blocked.statusCode).toBe(429);

    const body = blocked.json();
    expect(body.error).toBe('Too Many Requests');
    expect(body.message).toMatch(/Rate limit exceeded/);
    expect(typeof body.retryAfter).toBe('number');
  });

  it('returns 429 on expensive endpoint after its stricter limit', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/communities/community-1/members',
      });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: 'GET',
      url: '/v1/communities/community-1/members',
    });
    expect(blocked.statusCode).toBe(429);
  });
});

describe('Rate limiting — disabled', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildRateLimitedApp({
      enabled: false,
      max: 2,
      expensiveMax: 1,
      timeWindow: 60_000,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows unlimited requests when rate limiting is disabled', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/access/check' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('does not attach x-ratelimit headers when disabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/access/check' });
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
  });
});

describe('Rate limiting — health check exemption', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildRateLimitedApp({
      enabled: true,
      max: 2,
      expensiveMax: 1,
      timeWindow: 60_000,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('never rate-limits the health/live endpoint', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'GET', url: '/health/live' });
      expect(res.statusCode).toBe(200);
    }
  });
});
