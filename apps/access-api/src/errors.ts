import type { ApiErrorResponse } from '@guildpass/shared-types';

/** Standard error payload that every error response uses. */
export interface ErrorPayload {
  statusCode: number;
  code: string;
  message: string;
  details?: string | Record<string, unknown>;
}

/** Build a standardised error response envelope. */
export function createApiError(payload: ErrorPayload): ApiErrorResponse {
  return {
    error: payload.code,
    code: payload.code,
    message: payload.message,
    statusCode: payload.statusCode,
    ...(payload.details !== undefined ? { details: payload.details } : {}),
  };
}

export function notFound(message: string, details?: string | Record<string, unknown>): ApiErrorResponse {
  return createApiError({ statusCode: 404, code: 'NOT_FOUND', message, details });
}

export function validationError(message: string, details?: string | Record<string, unknown>): ApiErrorResponse {
  return createApiError({ statusCode: 400, code: 'VALIDATION_ERROR', message, details });
}

export function unauthorized(message: string): ApiErrorResponse {
  return createApiError({ statusCode: 401, code: 'UNAUTHORIZED', message });
}

export function internalError(message: string): ApiErrorResponse {
  return createApiError({ statusCode: 500, code: 'INTERNAL_ERROR', message });
}

export function conflict(message: string): ApiErrorResponse {
  return createApiError({ statusCode: 409, code: 'CONFLICT', message });
}

export function expired(message: string): ApiErrorResponse {
  return createApiError({ statusCode: 410, code: 'EXPIRED', message });
}
