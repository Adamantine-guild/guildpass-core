import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { redact, DEFAULT_REDACT_KEYS } from "@guildpass/log-redaction";

export interface RedactedLoggerOptions {
  customRedactKeys?: string[];
  enableRequestLogging?: boolean;
  enableResponseLogging?: boolean;
}

/**
 * Sanitizes headers by redacting sensitive values like authorization tokens and api keys.
 */
export function sanitizeHeaders(
  headers: Record<string, unknown>,
  customKeys?: string[]
): Record<string, unknown> {
  return redact(headers, {
    redactKeys: [...DEFAULT_REDACT_KEYS, ...(customKeys || [])],
  }) as Record<string, unknown>;
}

/**
 * Sanitizes an arbitrary object (e.g. payload, parameters) before logging.
 */
export function sanitizeLogData<T = unknown>(data: T, customKeys?: string[]): T {
  return redact(data, {
    redactKeys: [...DEFAULT_REDACT_KEYS, ...(customKeys || [])],
  });
}

/**
 * Fastify plugin enforcing structured, redacted logging across request/response lifecycle.
 */
export const redactedLoggerPlugin: FastifyPluginAsync<RedactedLoggerOptions> = async (
  fastify: FastifyInstance,
  options: RedactedLoggerOptions = {}
) => {
  const customKeys = options.customRedactKeys || [];
  const logRequests = options.enableRequestLogging !== false;
  const logResponses = options.enableResponseLogging !== false;

  fastify.addHook("onRequest", async (request: FastifyRequest) => {
    if (!logRequests || !request.log) return;

    request.log.info(
      {
        correlationId: request.correlationId,
        method: request.method,
        url: request.url,
        ip: request.ip,
        headers: sanitizeHeaders(request.headers as Record<string, unknown>, customKeys),
      },
      "Incoming HTTP request"
    );
  });

  fastify.addHook("preHandler", async (request: FastifyRequest) => {
    if (request.body && request.log) {
      const sanitizedBody = sanitizeLogData(request.body, customKeys);
      request.log.debug(
        {
          correlationId: request.correlationId,
          body: sanitizedBody,
        },
        "Request body payload (redacted)"
      );
    }
  });

  fastify.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!logResponses || !request.log) return;

    request.log.info(
      {
        correlationId: request.correlationId,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTimeMs: reply.elapsedTime,
      },
      "HTTP request completed"
    );
  });
};

(redactedLoggerPlugin as any)[Symbol.for("skip-override")] = true;

export default redactedLoggerPlugin;
