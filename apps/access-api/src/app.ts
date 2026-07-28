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
    // Allow the OpenAPI `example` keyword to pass through AJV validation
    // without triggering FST_ERR_SCH_VALIDATION_BUILD in strict mode.
    ajv: {
      customOptions: {
        keywords: ['example'],
      },
    },
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
        description:
          'MVP API for wallet membership and access checks.\n\n' +
          '## API Versioning & Compatibility\n\n' +
          'All responses include the `x-guildpass-api-version` header (e.g. `1.0.0`) ' +
          'indicating the version being served. The API commits to backwards ' +
          'compatibility on all `/v1` routes — fields will not be removed and ' +
          'new mandatory parameters will not be added without a major version bump. ' +
          'Routes being phased out will carry a `deprecation: true` response header ' +
          'for a minimum sunset period before removal.',
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
        headers: {
          'x-guildpass-api-version': {
            description:
              'Semantic version of the GuildPass Access API that served this response (e.g. `1.0.0`). ' +
              'Present on every response. Clients can inspect this header to detect server upgrades without ' +
              'polling `/health/live`.',
            schema: { type: 'string', example: '1.0.0' },
          },
          'x-request-id': {
            description:
              'Opaque correlation ID echoed from the incoming `x-request-id` / `x-correlation-id` ' +
              'request header, or a server-generated UUID when none is provided. ' +
              'Use this value when filing bug reports or tracing requests across services.',
            schema: { type: 'string', format: 'uuid', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
          },
          deprecation: {
            description:
              'Present with value `true` when the endpoint has been formally deprecated. ' +
              'Deprecated endpoints continue to function for the announced sunset period. ' +
              'Clients should monitor this header and migrate before the endpoint is removed.',
            schema: { type: 'string', enum: ['true'], example: 'true' },
          },
        },
        schemas: {
          Error: {
            type: 'object',
            required: ['error', 'code', 'message', 'statusCode'],
            description: 'Standard error envelope returned by every access-api error response.',
            properties: {
              error: { type: 'string', description: 'Machine-readable error identifier', example: 'VALIDATION_ERROR' },
              code: { type: 'string', description: 'HTTP status phrase / error code', example: 'VALIDATION_ERROR' },
              message: { type: 'string', description: 'Human-readable description', example: 'Invalid wallet format' },
              statusCode: { type: 'integer', description: 'HTTP status code', example: 400 },
              details: {
                description: 'Optional detail payload',
                oneOf: [{ type: 'string' }, { type: 'object' }],
              },
            },
            example: {
              error: 'VALIDATION_ERROR',
              code: 'VALIDATION_ERROR',
              message: 'Invalid wallet format',
              statusCode: 400,
            },
          },
          UnauthorizedError: {
            type: 'object',
            required: ['error', 'code', 'message', 'statusCode'],
            description: 'Returned when a request lacks valid authentication credentials.',
            properties: {
              error: { type: 'string', example: 'UNAUTHORIZED' },
              code: { type: 'string', example: 'UNAUTHORIZED' },
              message: { type: 'string', example: 'Missing or invalid API key' },
              statusCode: { type: 'integer', example: 401 },
            },
            example: {
              error: 'UNAUTHORIZED',
              code: 'UNAUTHORIZED',
              message: 'Missing or invalid API key',
              statusCode: 401,
            },
          },
          ForbiddenError: {
            type: 'object',
            required: ['error', 'code', 'message', 'statusCode'],
            description: 'Returned when the authenticated requester lacks the required permission.',
            properties: {
              error: { type: 'string', example: 'FORBIDDEN' },
              code: { type: 'string', example: 'FORBIDDEN' },
              message: { type: 'string', example: 'Requester is not a community admin' },
              statusCode: { type: 'integer', example: 403 },
            },
            example: {
              error: 'FORBIDDEN',
              code: 'FORBIDDEN',
              message: 'Requester is not a community admin',
              statusCode: 403,
            },
          },
          NotFoundError: {
            type: 'object',
            required: ['error', 'code', 'message', 'statusCode'],
            description: 'Returned when the requested resource does not exist.',
            properties: {
              error: { type: 'string', example: 'NOT_FOUND' },
              code: { type: 'string', example: 'NOT_FOUND' },
              message: { type: 'string', example: 'Resource not found' },
              statusCode: { type: 'integer', example: 404 },
            },
            example: {
              error: 'NOT_FOUND',
              code: 'NOT_FOUND',
              message: 'Resource not found',
              statusCode: 404,
            },
          },
          ConflictError: {
            type: 'object',
            required: ['error', 'code', 'message', 'statusCode'],
            description: 'Returned when the request conflicts with current resource state.',
            properties: {
              error: { type: 'string', example: 'CONFLICT' },
              code: { type: 'string', example: 'CONFLICT' },
              message: { type: 'string', example: 'A pending appeal already exists for this member' },
              statusCode: { type: 'integer', example: 409 },
            },
            example: {
              error: 'CONFLICT',
              code: 'CONFLICT',
              message: 'A pending appeal already exists for this member',
              statusCode: 409,
            },
          },
          InternalError: {
            type: 'object',
            required: ['error', 'code', 'message', 'statusCode'],
            description: 'Returned on unexpected server-side failures.',
            properties: {
              error: { type: 'string', example: 'INTERNAL_ERROR' },
              code: { type: 'string', example: 'INTERNAL_ERROR' },
              message: { type: 'string', example: 'Internal server error' },
              statusCode: { type: 'integer', example: 500 },
            },
            example: {
              error: 'INTERNAL_ERROR',
              code: 'INTERNAL_ERROR',
              message: 'Internal server error',
              statusCode: 500,
            },
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
      description:
        'Returns 200 when the process is alive. The `version` field reflects the ' +
        '`x-guildpass-api-version` header value served on all responses.',
      response: {
        200: {
          description: 'Server is alive',
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            version: { type: 'string', example: '1.0.0' },
          },
          example: { status: 'ok', version: '1.0.0' },
        },
      },
    },
  }, async (_req, reply) => {
    return reply.send({ status: 'ok', version: '1.0.0' });
  });

  app.get('/health/ready', {
    config: { rateLimit: false },
    schema: {
      tags: ['Health'],
      summary: 'Readiness probe',
      description:
        'Returns 200 when the database is reachable. Returns 503 when the ' +
        'database connection is degraded — load balancers should stop routing ' +
        'traffic to this instance until it recovers.',
      response: {
        200: {
          description: 'Server and database are ready',
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            db: { type: 'string', example: 'reachable' },
          },
          example: { status: 'ok', db: 'reachable' },
        },
        503: {
          description: 'Database is unreachable — instance is not ready to serve traffic',
          type: 'object',
          properties: {
            status: { type: 'string', example: 'degraded' },
            db: { type: 'string', example: 'unreachable' },
            error: { type: 'string', example: 'connect ECONNREFUSED 127.0.0.1:5432' },
          },
          example: {
            status: 'degraded',
            db: 'unreachable',
            error: 'connect ECONNREFUSED 127.0.0.1:5432',
          },
        },
      },
    },
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
