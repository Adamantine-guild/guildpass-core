import "fastify";
import type { RateLimiter } from "@guildpass/rate-limit";
import type { IdempotencyStore } from "@guildpass/idempotency";

export interface RequestAuthContext {
  subject: string;
  audience: string;
  scopes: string[];
  issuedAt?: number;
  expiresAt?: number;
  isApiKey?: boolean;
}

export interface RequestIdempotencyContext {
  key: string;
  fingerprint: string;
  acquired: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    auth?: RequestAuthContext;
    idempotencyKey?: string;
    idempotencyContext?: RequestIdempotencyContext;
  }

  interface FastifyInstance {
    rateLimiter?: RateLimiter;
    idempotencyStore?: IdempotencyStore;
  }
}
