import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { RateLimiterRedis, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { createClient } from 'redis';
import { config } from '../config';

declare module 'fastify' {
  interface FastifyInstance {
    accessCheckRateLimitHook: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const accessCheckRateLimiter: FastifyPluginAsync = async (app) => {
  if (!config.rateLimitEnabled) {
    app.decorate('accessCheckRateLimitHook', async () => {});
    return;
  }

  let rateLimiterIp: RateLimiterRedis | RateLimiterMemory;
  let rateLimiterWallet: RateLimiterRedis | RateLimiterMemory;

  const durationSec = Math.max(1, Math.floor(config.accessCheckRateLimitWindowMs / 1000));

  if (config.redisUrl) {
    const redisClient = createClient({ url: config.redisUrl });
    
    redisClient.on('error', (err) => {
      app.log.error({ err }, 'Redis connection error in accessCheckRateLimiter');
    });

    await redisClient.connect();

    rateLimiterIp = new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix: 'rate_limit_access_ip',
      points: config.accessCheckRateLimitIpMax,
      duration: durationSec,
    });

    rateLimiterWallet = new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix: 'rate_limit_access_wallet',
      points: config.accessCheckRateLimitWalletMax,
      duration: durationSec,
    });

    app.addHook('onClose', async () => {
      await redisClient.disconnect();
    });
  } else {
    rateLimiterIp = new RateLimiterMemory({
      keyPrefix: 'rate_limit_access_ip',
      points: config.accessCheckRateLimitIpMax,
      duration: durationSec,
    });

    rateLimiterWallet = new RateLimiterMemory({
      keyPrefix: 'rate_limit_access_wallet',
      points: config.accessCheckRateLimitWalletMax,
      duration: durationSec,
    });
  }

  const accessCheckRateLimitHook = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { wallet?: string };
    const wallet = body?.wallet?.toLowerCase() ?? 'unknown-wallet';
    
    const forwarded = request.headers['x-forwarded-for'];
    const ip = Array.isArray(forwarded)
      ? forwarded[0]
      : forwarded?.split(',')[0]?.trim();
    const finalIp = ip ?? request.ip;

    try {
      const results = await Promise.all([
        rateLimiterIp.consume(finalIp),
        rateLimiterWallet.consume(wallet)
      ]);

      reply.header('x-ratelimit-remaining-ip', results[0].remainingPoints);
      reply.header('x-ratelimit-remaining-wallet', results[1].remainingPoints);
    } catch (err: unknown) {
      // If it has msBeforeNext, it's a RateLimiterRes (limit exceeded)
      const isRateLimitExceeded = err && typeof err === 'object' && 'msBeforeNext' in err;

      if (isRateLimitExceeded) {
        const rateLimiterRes = err as RateLimiterRes;
        const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);
        
        reply.header('retry-after', retryAfter);
        reply.header('x-ratelimit-reset', retryAfter);
        
        return reply.status(429).send({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Retry after ${retryAfter} seconds.`
        });
      }

      // Otherwise it's a Redis connection error or similar
      app.log.error({ err }, 'Error in accessCheckRateLimiter');
      // Read fail-open flag at request time so it can be toggled via env without restart
      const failOpen = process.env.ACCESS_CHECK_RATE_LIMIT_FAIL_OPEN !== 'false' &&
                       process.env.ACCESS_CHECK_RATE_LIMIT_FAIL_OPEN !== '0';
      if (failOpen) {
        app.log.warn('Access check rate limiter failed open');
        return;
      } else {
        return reply.status(503).send({ error: 'Service Unavailable', message: 'Rate limiter unavailable' });
      }
    }
  };

  app.decorate('accessCheckRateLimitHook', accessCheckRateLimitHook);
};

export default fp(accessCheckRateLimiter, {
  name: 'accessCheckRateLimiter',
});
