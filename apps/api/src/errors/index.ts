import type { FastifyError, FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { redact } from "@guildpass/log-redaction";

/**
 * Base domain error for GuildPass Core.
 */
export class GuildPassError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(
    message: string,
    code = "INTERNAL_ERROR",
    statusCode = 500,
    isOperational = true,
    details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class AuthenticationError extends GuildPassError {
  constructor(message = "Authentication required", details?: unknown) {
    super(message, "AUTH_UNAUTHORIZED", 401, true, details);
  }
}

export class AuthorizationError extends GuildPassError {
  constructor(message = "Insufficient permissions for this operation", details?: unknown) {
    super(message, "AUTH_FORBIDDEN", 403, true, details);
  }
}

export class ValidationError extends GuildPassError {
  constructor(message = "Invalid request payload or parameters", details?: unknown) {
    super(message, "VALIDATION_FAILED", 400, true, details);
  }
}

export class NotFoundError extends GuildPassError {
  constructor(message = "Requested resource not found", details?: unknown) {
    super(message, "RESOURCE_NOT_FOUND", 404, true, details);
  }
}

export class ConflictError extends GuildPassError {
  constructor(message = "Resource state conflict", details?: unknown) {
    super(message, "RESOURCE_CONFLICT", 409, true, details);
  }
}

export class RateLimitExceededError extends GuildPassError {
  public readonly retryAfterMs?: number;

  constructor(message = "Rate limit exceeded. Please retry later.", retryAfterMs?: number) {
    super(message, "RATE_LIMIT_EXCEEDED", 429, true, { retryAfterMs });
    this.retryAfterMs = retryAfterMs;
  }
}

export class IdempotencyConflictError extends GuildPassError {
  constructor(message = "Idempotency conflict detected", details?: unknown) {
    super(message, "IDEMPOTENCY_CONFLICT", 409, true, details);
  }
}

export class StellarTransactionError extends GuildPassError {
  public readonly isRetryable: boolean;
  public readonly txResultCode?: string;

  constructor(
    message: string,
    options: {
      isRetryable: boolean;
      txResultCode?: string;
      statusCode?: number;
      details?: unknown;
    }
  ) {
    super(
      message,
      "STELLAR_TRANSACTION_ERROR",
      options.statusCode ?? (options.isRetryable ? 503 : 400),
      true,
      options.details
    );
    this.isRetryable = options.isRetryable;
    this.txResultCode = options.txResultCode;
  }
}

export class InternalServerError extends GuildPassError {
  constructor(message = "An unexpected error occurred", details?: unknown) {
    super(message, "INTERNAL_ERROR", 500, false, details);
  }
}

export interface PublicErrorPayload {
  code: string;
  message: string;
  correlationId?: string;
  details?: unknown;
}

/**
 * Sanitizes any error before returning it to the caller.
 * Never leaks database connection strings, stack traces, private keys, or internal secrets.
 */
export function sanitizeError(
  err: unknown,
  correlationId?: string
): { statusCode: number; payload: { error: PublicErrorPayload } } {
  if (err instanceof GuildPassError && err.isOperational) {
    const sanitizedDetails = err.details !== undefined ? redact(err.details) : undefined;
    return {
      statusCode: err.statusCode,
      payload: {
        error: {
          code: err.code,
          message: err.message,
          correlationId,
          ...(sanitizedDetails !== undefined ? { details: sanitizedDetails } : {}),
        },
      },
    };
  }

  // Handle Fastify schema validation errors
  if (err && typeof err === "object" && "validation" in err && (err as any).statusCode === 400) {
    const fastifyErr = err as FastifyError;
    return {
      statusCode: 400,
      payload: {
        error: {
          code: "VALIDATION_FAILED",
          message: fastifyErr.message || "Request validation failed",
          correlationId,
          details: redact(fastifyErr.validation),
        },
      },
    };
  }

  // Any unhandled internal or infrastructure error is masked
  return {
    statusCode: 500,
    payload: {
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal server error occurred",
        correlationId,
      },
    },
  };
}

/**
 * Fastify plugin attaching structured, sanitized error handling across all routes.
 */
export const errorHandlerPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = request.correlationId;
    const { statusCode, payload } = sanitizeError(error, correlationId);

    // Log the error securely with redaction
    if (request.log) {
      const logPayload = redact({
        correlationId,
        errorName: error.name,
        errorMessage: error.message,
        errorCode: payload.error.code,
        statusCode,
        stack: statusCode >= 500 ? error.stack : undefined,
      });

      if (statusCode >= 500) {
        request.log.error(logPayload, "Unhandled server error caught by error handler");
      } else {
        request.log.warn(logPayload, "Client operational error caught by error handler");
      }
    }

    reply.status(statusCode).send(payload);
  });
};

(errorHandlerPlugin as any)[Symbol.for("skip-override")] = true;

export default errorHandlerPlugin;
