import type { FastifyReply, FastifyRequest } from "fastify";
import {
  type CapabilityPayload,
  verifyToken,
} from "@guildpass/capability-token";
import { AuthenticationError, AuthorizationError } from "../errors/index.js";

export interface AuthOptions {
  secret?: string;
  audience?: string;
  requiredScopes?: string[];
  anyScopes?: string[];
}

export const DEFAULT_AUTH_SECRET =
  process.env.GUILDPASS_AUTH_SECRET || "guildpass-production-auth-secret-key-32b";
export const DEFAULT_AUDIENCE = "guildpass-core";

/**
 * Checks if current scopes array contains all required scopes.
 */
export function checkAllScopes(currentScopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.every((scope) => currentScopes.includes(scope));
}

/**
 * Checks if current scopes array contains at least one of the specified scopes.
 */
export function checkAnyScope(currentScopes: string[], anyScopes: string[]): boolean {
  return anyScopes.some((scope) => currentScopes.includes(scope));
}

/**
 * Extracts a token string from the request Authorization header or x-api-key header.
 */
export function extractToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader) {
    const [scheme, token] = authHeader.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token) {
      return token.trim();
    }
  }

  const apiKeyHeader = request.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim().length > 0) {
    return apiKeyHeader.trim();
  }

  return null;
}

/**
 * Authenticates the incoming request, verifying the capability token and decorating request.auth.
 */
export async function authenticateRequest(
  request: FastifyRequest,
  options: AuthOptions = {}
): Promise<CapabilityPayload> {
  const token = extractToken(request);
  if (!token) {
    throw new AuthenticationError("Authentication token is missing. Please provide a Bearer token or API key.");
  }

  const secret = options.secret || DEFAULT_AUTH_SECRET;
  const audience = options.audience || DEFAULT_AUDIENCE;

  const verification = verifyToken(token, {
    secret,
    audience,
  });

  if (!verification.valid || !verification.payload) {
    throw new AuthenticationError(
      verification.reason || "Invalid or expired capability token"
    );
  }

  const payload = verification.payload;

  // Decorate the request context
  request.auth = {
    subject: payload.subject,
    audience: payload.audience,
    scopes: payload.scopes,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };

  return payload;
}

/**
 * Pre-handler hook requiring the request to be authenticated.
 */
export function requireAuth(options: AuthOptions = {}) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.auth) {
      await authenticateRequest(request, options);
    }
  };
}

/**
 * Pre-handler hook enforcing that the caller holds ALL specified scopes.
 * Serves as the primary mutation authorization boundary.
 */
export function requireScopes(scopes: string[], options: AuthOptions = {}) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.auth) {
      await authenticateRequest(request, options);
    }

    const currentScopes = request.auth?.scopes || [];
    if (!checkAllScopes(currentScopes, scopes)) {
      const missing = scopes.filter((s) => !currentScopes.includes(s));
      throw new AuthorizationError(
        `Missing required authorization scope(s): ${missing.join(", ")}`,
        { requiredScopes: scopes, missingScopes: missing }
      );
    }
  };
}

/**
 * Pre-handler hook enforcing that the caller holds at least one of the specified scopes.
 */
export function requireAnyScope(scopes: string[], options: AuthOptions = {}) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.auth) {
      await authenticateRequest(request, options);
    }

    const currentScopes = request.auth?.scopes || [];
    if (!checkAnyScope(currentScopes, scopes)) {
      throw new AuthorizationError(
        `Requires at least one of the following scope(s): ${scopes.join(", ")}`,
        { requiredScopes: scopes }
      );
    }
  };
}
