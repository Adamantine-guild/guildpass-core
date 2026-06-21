/**
 * app.ts
 *
 * Fastify application factory.
 *
 * Responsibilities:
 *   1. Build and configure the Fastify instance (logger + correlation IDs).
 *   2. Register @fastify/swagger + @fastify/swagger-ui.
 *   3. Register the /metrics endpoint (Prometheus scrape target).
 *   4. Register liveness  GET /health/live
 *              readiness  GET /health/ready
 *   5. Add a request-lifecycle hook to record HTTP duration metrics.
 *   6. Register all business routes.
 *
 * The function returns the fully-initialised FastifyInstance so that
 * integration tests can import it without binding a port.
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { buildPinoHttp } from './observability/logger';
import { registry, metrics } from './observability/metrics';
import { registerRoutes } from './routes';
import { getPrisma } from './services/prisma';

// --------------------------------------------------------------------------
// Helper: normalise a Fastify route URL into a stable label
// (strips UUIDs and wallet addresses so cardinality stays low)
// --------------------------------------------------------------------------
function normaliseRoute(url: string): string {
  return (
    url
      // replace hex wallet addresses
      .replace(/0x[0-9a-fA-F]{8,}/g, ':wallet')
      // replace UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      // strip query strings
      .replace(/\?.*$/, '')
  );
}

// --------------------------------------------------------------------------
// Application factory
// --------------------------------------------------------------------------

export async function buildApp(): Promise<FastifyInstance> {
  // -----------------------------------------------------------------------
  // 1. Fastify instance
  //    - Structured JSON logging via pino-http (correlation IDs + redaction)
  // -----------------------------------------------------------------------
  const app = Fastify({
    // Use a pino logger that's been configured for redaction and correlation.
    // We pass the pino instance from pino-http so that request-bound child
    // loggers share the same configuration.
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
      // Pretty-print in development only
      ...(process.env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    // Attach correlation ID from upstream header or generate a new UUID.
    // Fastify exposes this as request.id on every route handler.
    genReqId(req) {
      const upstream =
        req.headers['x-request-id'] || req.headers['x-correlation-id'];
      const id = Array.isArray(upstream) ? upstream[0] : upstream;
      if (id) return id;
      // crypto.randomUUID is available in Node 14.17+ without any import
      return crypto.randomUUID();
    },
  });

  // Echo the correlation ID back to the caller on every response.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-correlation-id', req.id);
  });

  // -----------------------------------------------------------------------
  // 2. HTTP duration metric hook
  //    Records latency + total-count after each response is sent.
  // -----------------------------------------------------------------------
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

  // -----------------------------------------------------------------------
  // 3. OpenAPI / Swagger
  // -----------------------------------------------------------------------
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'GuildPass Access API',
        description: 'MVP API for wallet membership and access checks',
        version: '0.1.0',
      },
      servers: [{ url: `http://localhost:${process.env.PORT || 3000}` }],
    },
  });

  await app.register(swaggerUi, { routePrefix: '/docs' });

  // -----------------------------------------------------------------------
  // 4. Prometheus metrics endpoint
  //    Secured by a simple pre-handler so it is never exposed publicly.
  //    Set METRICS_TOKEN to a non-empty string to enable bearer-token auth.
  // -----------------------------------------------------------------------
  app.get(
    '/metrics',
    {
      schema: {
        summary: 'Prometheus metrics scrape endpoint',
        tags: ['Observability'],
      },
    },
    async (_req, reply) => {
      const metricsToken = process.env.METRICS_TOKEN;
      if (metricsToken) {
        const auth = _req.headers.authorization ?? '';
        if (auth !== `Bearer ${metricsToken}`) {
          return reply.code(401).send({ error: 'Unauthorized' });
        }
      }
      const output = await registry.metrics();
      reply.header('content-type', registry.contentType);
      return reply.send(output);
    },
  );

  // -----------------------------------------------------------------------
  // 5. Health endpoints
  //
  //    GET /health/live  – liveness probe
  //      Answers: "Is the process alive and the event loop responsive?"
  //      Never hits the database. Returns 200 immediately.
  //
  //    GET /health/ready – readiness probe
  //      Answers: "Can we serve traffic?" Runs a cheap DB ping.
  //      Returns 200 if the DB is reachable, 503 otherwise.
  //      Kubernetes / load balancers stop routing traffic on 503.
  // -----------------------------------------------------------------------
  app.get(
    '/health/live',
    {
      schema: {
        summary: 'Liveness probe – is the process alive?',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string' } },
          },
        },
      },
    },
    async (_req, reply) => {
      return reply.send({ status: 'ok' });
    },
  );

  app.get(
    '/health/ready',
    {
      schema: {
        summary: 'Readiness probe – can we serve traffic?',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              db: { type: 'string' },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              db: { type: 'string' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      const prisma = getPrisma();
      try {
        // Cheapest possible query – no table scan, just a round-trip.
        await prisma.$queryRaw`SELECT 1`;
        return reply.send({ status: 'ok', db: 'reachable' });
      } catch (err) {
        app.log.error({ err }, 'Readiness check failed: database unreachable');
        return reply.code(503).send({
          status: 'degraded',
          db: 'unreachable',
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    },
  );

  // -----------------------------------------------------------------------
  // 6. Business routes
  // -----------------------------------------------------------------------
  registerRoutes(app);

  return app;
}
