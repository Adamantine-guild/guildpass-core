/**
 * app.ts
 *
 * Fastify application factory.
 */

import { randomUUID } from 'node:crypto';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import { createClient } from 'redis';

import { buildPinoHttp } from './observability/logger';
import { registry, metrics } from './observability/metrics';
import { registerRoutes } from './routes';
import { getPrisma } from './services/prisma';
import { createApiError, unauthorized } from './errors';
import { isValidWalletAddress } from './lib/wallet';
import { config } from './config';
import { setRequestContext } from './services/requestContext';
import accessCheckRateLimiter from './plugins/accessCheckRateLimiter';

// --------------------------------------------------------------------------
// Helper: interpret the TRUST_PROXY setting for Fastify
//
// Fastify only derives request.ip from X-Forwarded-For when trustProxy is set.
// Left off (the default), the header is ignored and request.ip is the socket
// address — which is what rate limiting must key on, since an untrusted
// X-Forwarded-For lets any caller mint a fresh bucket on every request.
// --------------------------------------------------------------------------
export function parseTrustProxy(value: string): boolean | number | string[] {
  const raw = value.trim();
  if (raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// --------------------------------------------------------------------------
// Helper: normalise a Fastify route URL into a stable label
// --------------------------------------------------------------------------
function normaliseRoute(url: string): string {
  return (
    url
      .replace(/0x[0-9a-fA-F]{8,}/g, ':wallet')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\?.*$/, '')
  );
}

// --------------------------------------------------------------------------
// Application factory
// --------------------------------------------------------------------------

/**
 * preHandler that rejects a malformed EVM address in any `:wallet` path param
 * with a clear 400 before it reaches the database layer, where a mixed-case or
 * invalid value would otherwise silently miss an existing record (#173).
 * Exported so it can be exercised in isolation.
 */
export async function walletParamGuard(
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const wallet = (req.params as { wallet?: string } | undefined)?.wallet;
  if (wallet !== undefined && !isValidWalletAddress(wallet)) {
    return reply.code(400).send(
      createApiError({
        statusCode: 400,
        code: 'INVALID_WALLET',
        message: `Invalid wallet address: '${wallet}'`,
      }),
    );
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // When set, Fastify validates X-Forwarded-For against the trusted proxies
    // and exposes the real client address as request.ip. When unset, the header
    // is ignored entirely so it cannot be used to evade rate limits.
    trustProxy: parseTrustProxy(config.trustProxy),
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'req.body.wallet',
        ],
        censor: '[REDACTED]',
      },
      ...(process.env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    genReqId(req) {
      const upstream = req.headers['x-request-id'] || req.headers['x-correlation-id'];
      const id = Array.isArray(upstream) ? upstream[0] : upstream;
      if (id) return id;
      return randomUUID();
    },
  });

  // Make the correlation ID available to services/outbox writes for the
  // lifetime of the request.
  app.addHook('onRequest', async (req) => {
    setRequestContext({ correlationId: req.id });
    req.log.info({ correlationId: req.id }, 'Request correlation context initialized');
  });

  // Echo the correlation ID back to the caller on every response.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-correlation-id', req.id);
    reply.header('x-guildpass-api-version', '1.0.0');

    if (req.routeOptions?.schema?.deprecated) {
      reply.header('deprecation', 'true');
    }
  });

  app.addHook(
    'onResponse',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const route = req.routerPath ?? normaliseRoute(req.url);
      const labels = {
        method: req.method,
        route,
        status_code: String(reply.statusCode),
      };
      const durationSeconds = reply.getResponseTime() / 1000;
      metrics.httpRequestDuration.observe(labels, durationSeconds);
      metrics.httpRequestsTotal.inc(labels);
    },
  );

  // Reject malformed EVM addresses in any :wallet path param with a clear 400
  // before they reach the database layer (see walletParamGuard, #173).
  app.addHook('preHandler', walletParamGuard);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'GuildPass Access API',
        description: 'MVP API for wallet membership and access checks',
        version: '0.1.0',
      },
      servers: [{ url: `http://localhost:${process.env.PORT || 3000}` }],
      components: {
        securitySchemes: {
          RequesterWallet: {
            type: 'apiKey',
            in: 'header',
            name: 'x-wallet',
            description:
              'Requester identity for admin-only routes. Clients should send x-wallet. For backwards compatibility, the server resolves requester headers in this precedence order: x-wallet, x-user-wallet, then x-requester-wallet.',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, { routePrefix: '/docs' });

  let redisClient: any;
  if (config.rateLimitEnabled && config.redisUrl) {
    redisClient = createClient({ url: config.redisUrl });
    redisClient.on('error', (err: any) => {
      app.log.error({ err }, 'Redis connection error in global rateLimit');
    });
    await redisClient.connect();
    app.addHook('onClose', async () => {
      await redisClient.disconnect();
    });
  }

  if (config.rateLimitEnabled) {
    await app.register(rateLimit, {
      global: true,
      max: config.rateLimitDefaultMax,
      timeWindow: config.rateLimitWindowMs,
      redis: redisClient,
      skipOnError: true,
      // Prefer the caller's API key so that integrators sharing an egress IP
      // (cloud providers, NAT'd Discord bots) get independent budgets. Falls
      // back to request.ip, which Fastify derives under the trustProxy policy
      // above rather than from a raw, spoofable header.
      keyGenerator: (req) => {
        const apiKey = req.headers['x-api-key'];
        const key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
        return key ? `key:${key}` : `ip:${req.ip}`;
      },
      errorResponseBuilder: (_req, context) => ({
        statusCode: 429,
        error: {
          code: 'RATE_LIMITED',
          message: `Rate limit exceeded. Retry after ${Math.ceil(context.ttl / 1000)} seconds.`,
          details: { retryAfter: Math.ceil(context.ttl / 1000) },
        },
      }),
      addHeaders: {
        'x-ratelimit-limit': true,
        'x-ratelimit-remaining': true,
        'x-ratelimit-reset': true,
        'retry-after': true,
      },
    });
  }

  app.get('/metrics', { config: { rateLimit: false } }, async (_req, reply) => {
    const metricsToken = process.env.METRICS_TOKEN;
    if (metricsToken) {
      const auth = _req.headers.authorization ?? '';
      if (auth !== `Bearer ${metricsToken}`) {
        return reply.code(401).send(unauthorized('Invalid or missing metrics token'));
      }
    }
    const output = await registry.metrics();
    reply.header('content-type', registry.contentType);
    return reply.send(output);
  });

  app.get('/health/live', {
    config: { rateLimit: false },
    schema: {
      tags: ['Health'],
      summary: 'Liveness probe',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            version: { type: 'string' }
          }
        }
      }
    }
  }, async (_req, reply) => {
    return reply.send({ status: 'ok', version: '1.0.0' });
  });

  app.get('/health/ready', {
    config: { rateLimit: false },
    schema: {
      tags: ['Health'],
      summary: 'Readiness probe',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            db: { type: 'string' }
          }
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            db: { type: 'string' },
            error: { type: 'string' }
          }
        }
      }
    }
  }, async (_req, reply) => {
    const prisma = getPrisma();
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.send({ status: 'ok', db: 'reachable' });
    } catch (err) {
      app.log.error({ err }, 'Readiness check failed');
      return reply.code(503).send({
        status: 'degraded',
        db: 'unreachable',
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  });

  await app.register(accessCheckRateLimiter);
  registerRoutes(app);

  // -----------------------------------------------------------------------
  // Global Error Handler - Standardize all /v1 error responses
  // -----------------------------------------------------------------------
  app.setErrorHandler(async (error: any, req: FastifyRequest, reply: FastifyReply) => {
    req.log.error({ err: error, reqId: req.id }, 'Unhandled error');

    // If the error already carries our structured { error: { code, message } } envelope
    // (e.g. from @fastify/rate-limit's errorResponseBuilder), forward it as-is.
    if (error.error && typeof error.error === 'object' && error.error.code) {
      return reply.code(error.statusCode || 429).send({ error: error.error });
    }

    const statusCode2 = error.statusCode || 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';

    if (error.validation) {
      code = 'VALIDATION_ERROR';
      message = 'Invalid request payload';
    } else if (statusCode2 === 401) {
      code = 'UNAUTHORIZED';
      message = error.message || 'Unauthorized';
    } else if (statusCode2 === 404) {
      code = 'NOT_FOUND';
      message = error.message || 'Resource not found';
    } else if (statusCode2 === 409) {
      code = 'CONFLICT';
      message = error.message || 'Resource conflict';
    } else if (statusCode2 === 429) {
      code = 'RATE_LIMITED';
      message = error.message || 'Rate limit exceeded';
    }

    const response = createApiError({
      statusCode: statusCode2,
      code,
      message,
      details: error.details || error.message,
    });

    return reply.code(statusCode2).send(response);
  });

  return app;
}
