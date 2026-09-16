import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  type IdempotencyStore,
  InMemoryIdempotencyStore,
  IdempotencyEngine,
} from "@guildpass/idempotency";
import { IdempotencyConflictError, ValidationError } from "../errors/index.js";

export interface IdempotencyPluginOptions {
  store?: IdempotencyStore;
  ttlMs?: number;
  headerName?: string;
  enforceOnMutations?: boolean;
}

export const DEFAULT_IDEMPOTENCY_HEADER = "idempotency-key";
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface IdempotencyContext {
  key: string;
  fingerprint: string;
  acquired: boolean;
}

export const idempotencyPlugin: FastifyPluginAsync<IdempotencyPluginOptions> = async (
  fastify: FastifyInstance,
  options: IdempotencyPluginOptions = {}
) => {
  const store = options.store ?? new InMemoryIdempotencyStore();
  const ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const primaryHeader = (options.headerName || DEFAULT_IDEMPOTENCY_HEADER).toLowerCase();

  fastify.decorate("idempotencyStore", store);

  // Pre-handler hook to inspect idempotency key and intercept replays
  fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const method = request.method.toUpperCase();
    const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

    if (!isMutation) {
      return;
    }

    const rawHeader =
      request.headers[primaryHeader] || request.headers["x-idempotency-key"];
    const key = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (!key) {
      if (options.enforceOnMutations) {
        throw new ValidationError(
          `Missing required idempotency key header (${primaryHeader}) for mutation operation.`
        );
      }
      return;
    }

    const trimmedKey = key.trim();
    if (trimmedKey.length === 0 || trimmedKey.length > 256) {
      throw new ValidationError(
        "Idempotency key must be a non-empty string of maximum 256 characters."
      );
    }

    // Generate canonical fingerprint of the mutating request
    const fingerprint = IdempotencyEngine.generateFingerprint({
      method,
      url: request.url,
      body: request.body ?? {},
    });

    const acquireResult = await store.acquire<{
      statusCode: number;
      body: unknown;
    }>({
      key: trimmedKey,
      fingerprint,
      ttlMs,
    });

    if (acquireResult.type === "conflict") {
      throw new IdempotencyConflictError(
        "Idempotency key has already been used with a different request payload or endpoint."
      );
    }

    if (acquireResult.type === "in_flight") {
      throw new IdempotencyConflictError(
        "A request with this idempotency key is currently processing. Please wait for completion."
      );
    }

    if (acquireResult.type === "completed") {
      const cached = acquireResult.result;
      reply.header("Idempotent-Replay", "true");
      reply.header("x-idempotency-key", trimmedKey);
      reply.status(cached.statusCode).send(cached.body);
      return reply;
    }

    // Acquired successfully
    (request as any).idempotencyContext = {
      key: trimmedKey,
      fingerprint,
      acquired: true,
    } satisfies IdempotencyContext;
  });

  // onSend hook to cache successful mutation responses or release lock on failure
  fastify.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const ctx = (request as any).idempotencyContext as IdempotencyContext | undefined;
    if (!ctx || !ctx.acquired) {
      return payload;
    }

    const statusCode = reply.statusCode;

    // Successful mutations (2xx) are stored for replay
    if (statusCode >= 200 && statusCode < 300) {
      let parsedBody: unknown = payload;
      if (typeof payload === "string") {
        try {
          parsedBody = JSON.parse(payload);
        } catch {
          parsedBody = payload;
        }
      }

      await store.complete(
        ctx.key,
        ctx.fingerprint,
        {
          statusCode,
          body: parsedBody,
        },
        ttlMs
      );
    } else {
      // On error (4xx/5xx), release the lock so the client can retry
      await store.release(ctx.key, ctx.fingerprint);
    }

    return payload;
  });
};

(idempotencyPlugin as any)[Symbol.for("skip-override")] = true;

export default idempotencyPlugin;
