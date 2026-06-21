/**
 * logger.ts
 *
 * Centralised Pino logger configuration with:
 * - Correlation ID injection via pino-http
 * - Log redaction for sensitive fields (wallet addresses, auth headers)
 *
 * Dependencies: pino (bundled with Fastify), pino-http, uuid
 */

import pinoHttp from 'pino-http';
import { v4 as uuidv4 } from 'uuid';

/**
 * Masks a wallet address: keeps the first 6 and last 4 chars visible.
 * e.g.  0xAbCd...1234
 */
function maskWallet(value: unknown): string {
  if (typeof value !== 'string') return '[REDACTED]';
  if (value.length <= 10) return '[REDACTED]';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/**
 * pino-http middleware factory.
 *
 * Attaches a `reqId` correlation ID to every request, propagated through
 * `request.id` and emitted on every log line produced during the request
 * lifecycle.
 */
export function buildPinoHttp() {
  return pinoHttp({
    // ------------------------------------------------------------------
    // Correlation ID
    // ------------------------------------------------------------------
    // Honour an upstream X-Request-Id if present (e.g. from a gateway),
    // otherwise generate a fresh v4 UUID.
    genReqId(req) {
      const upstream =
        req.headers['x-request-id'] || req.headers['x-correlation-id'];
      return Array.isArray(upstream) ? upstream[0] : upstream || uuidv4();
    },

    // Always write the id as "correlationId" in JSON logs.
    customAttributeKeys: { reqId: 'correlationId' },

    // ------------------------------------------------------------------
    // Redaction
    // ------------------------------------------------------------------
    redact: {
      paths: [
        // Standard auth headers
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',

        // Wallet addresses inside request bodies / response bodies
        'req.body.wallet',
        'res.body.wallet',

        // Any nested wallet fields two levels deep
        '*.wallet',
        'req.body.*.wallet',
      ],
      censor: '[REDACTED]',
    },

    // ------------------------------------------------------------------
    // Custom serialisers
    // ------------------------------------------------------------------
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url,
          // Strip query string wallet params from logs
          hostname: req.hostname,
          remoteAddress: req.remoteAddress,
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },

    // ------------------------------------------------------------------
    // Log level mapping
    // ------------------------------------------------------------------
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },

    // Pretty-print only in development; JSON in all other envs.
    transport:
      process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}

/**
 * Utility: safely hash/mask a wallet address for use inside service logs.
 * Call this whenever you need to log wallet data outside of the HTTP layer.
 */
export { maskWallet };
