import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { RateLimiter, InMemoryRateLimitStore, type RateLimitStore } from "@guildpass/rate-limit";
import { RateLimitExceededError } from "../errors/index.js";

export interface RateLimitPluginOptions {
  limit?: number;
  windowMs?: number;
  store?: RateLimitStore;
  keyGenerator?: (request: FastifyRequest) => string;
  skip?: (request: FastifyRequest) => boolean;
}

export const rateLimitPlugin: FastifyPluginAsync<RateLimitPluginOptions> = async (
  fastify: FastifyInstance,
  options: RateLimitPluginOptions = {}
) => {
  const limit = options.limit ?? 100;
  const windowMs = options.windowMs ?? 60000;
  const store = options.store ?? new InMemoryRateLimitStore();
  const keyGenerator =
    options.keyGenerator ??
    ((req: FastifyRequest) => {
      if (req.auth?.subject) {
        return `auth:${req.auth.subject}`;
      }
      return `ip:${req.ip || "127.0.0.1"}`;
    });

  const limiter = new RateLimiter({
    limit,
    windowMs,
    store,
  });

  fastify.decorate("rateLimiter", limiter);

  fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.skip && options.skip(request)) {
      return;
    }

    const key = keyGenerator(request);
    const decision = await limiter.check(key);

    reply.header("X-RateLimit-Limit", decision.limit.toString());
    reply.header("X-RateLimit-Remaining", decision.remaining.toString());
    reply.header("X-RateLimit-Reset", Math.ceil(decision.resetAt / 1000).toString());

    if (!decision.allowed) {
      const retryAfterSec = Math.ceil((decision.retryAfterMs ?? windowMs) / 1000);
      reply.header("Retry-After", retryAfterSec.toString());
      throw new RateLimitExceededError(
        `Rate limit exceeded. Please retry after ${retryAfterSec} second(s).`,
        decision.retryAfterMs ?? windowMs
      );
    }
  });
};

(rateLimitPlugin as any)[Symbol.for("skip-override")] = true;

export default rateLimitPlugin;
