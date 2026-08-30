import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

export interface CorrelationOptions {
  headerName?: string;
  maxHeaderLength?: number;
}

export const DEFAULT_HEADER_NAME = "x-correlation-id";
export const DEFAULT_MAX_LENGTH = 128;

/**
 * Validates whether a correlation ID candidate is safe and acceptable.
 * A valid correlation ID must be a non-empty string within max length bounds
 * containing only alphanumeric characters, hyphens, underscores, dots, or colons.
 * Rejects control characters, newlines, spaces, and dangerous log injection payloads.
 */
export function isValidCorrelationId(
  id: unknown,
  maxLength: number = DEFAULT_MAX_LENGTH
): id is string {
  if (typeof id !== "string") {
    return false;
  }
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length !== id.length || id.length > maxLength) {
    return false;
  }
  // Safe characters for tracing identifiers
  const safeRegex = /^[a-zA-Z0-9._:-]+$/;
  return safeRegex.test(id);
}

export const correlationPlugin: FastifyPluginAsync<CorrelationOptions> = async (
  fastify: FastifyInstance,
  opts?: CorrelationOptions
) => {
  const headerName = (opts?.headerName || DEFAULT_HEADER_NAME).toLowerCase();
  const maxLength = opts?.maxHeaderLength || DEFAULT_MAX_LENGTH;

  fastify.decorateRequest("correlationId", "");

  fastify.addHook("onRequest", async (request: FastifyRequest, reply) => {
    const rawHeader = request.headers[headerName];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    let correlationId: string;

    if (headerValue && isValidCorrelationId(headerValue, maxLength)) {
      correlationId = headerValue;
    } else {
      correlationId = randomUUID();
    }

    request.correlationId = correlationId;

    // Return header on response
    reply.header(headerName, correlationId);

    // Attach to request-scoped logging context if logger is enabled
    if (request.log) {
      request.log = request.log.child({ correlationId });
    }
  });
};

// Skip override so decorator is available globally across fastify instance without encapsulation barriers
(correlationPlugin as any)[Symbol.for("skip-override")] = true;

export default correlationPlugin;
