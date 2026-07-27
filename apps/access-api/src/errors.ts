import type { ApiErrorResponse } from '@guildpass/shared-types';

/** Standard error payload that every error response uses. */
export interface ErrorPayload {
  statusCode: number;
  code: string;
  message: string;
  details?: string | Record<string, unknown>;
}

export function createApiError(payload: ErrorPayload): ApiErrorResponse {
  return {
    error: {
      code: payload.code as any, // Cast to any to appease ApiErrorCode for now, although it should be a string union.
      message: payload.message,
      ...(payload.details !== undefined ? { details: payload.details } : {}),
    }
  };
}

export function notFound(message: string, details?: string | Record<string, unknown>): ApiErrorResponse {
  return createApiError({ statusCode: 404, code: 'NOT_FOUND', message, details });
}

export function validationError(message: string, details?: string | Record<string, unknown>): ApiErrorResponse {
  return createApiError({ statusCode: 400, code: 'VALIDATION_ERROR', message, details });
}

export function validationErrorWithReason(
  code: string,
  message: string,
): ApiErrorResponse & { reasons: { code: string; message: string }[] } {
  const base = createApiError({ statusCode: 400, code, message, details: code });
  return {
    ...base,
    reasons: [{ code, message }]
  };
}

export function unauthorized(message: string): ApiErrorResponse {
  return createApiError({ statusCode: 401, code: 'UNAUTHORIZED', message });
}

export function internalError(message: string): ApiErrorResponse {
  return createApiError({ statusCode: 500, code: 'INTERNAL_ERROR', message });
}

export function forbidden(message: string): ApiErrorResponse {
  return createApiError({ statusCode: 403, code: 'FORBIDDEN', message });
}

export function conflict(message: string): ApiErrorResponse {
  return createApiError({ statusCode: 409, code: 'CONFLICT', message });
}

export function expired(message: string): ApiErrorResponse {
  return createApiError({ statusCode: 410, code: 'EXPIRED', message });
}

export function rateLimited(message: string, details?: string | Record<string, unknown>): ApiErrorResponse {
  return createApiError({ statusCode: 429, code: 'RATE_LIMITED', message, details });
}

export function serviceUnavailable(message: string): ApiErrorResponse {
  return createApiError({ statusCode: 503, code: 'SERVICE_UNAVAILABLE', message });
}
