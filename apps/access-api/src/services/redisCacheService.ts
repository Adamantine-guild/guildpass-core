import type { CacheService } from './cacheService';
import { NoopCacheService } from './cacheService';

// Optional dependency: only used when redisUrl is configured.
// We keep it in a separate file to avoid loading redis libraries when disabled.

/**
 * Lua script that atomically increments a key and sets its TTL in one
 * round-trip.  Because Redis executes Lua scripts atomically, a crash or
 * connection drop between the INCR and the EXPIRE can no longer leave the
 * key without a TTL (fixes issue #126).
 *
 * KEYS[1]  – the counter key
 * ARGV[1]  – TTL in seconds (integer); pass "0" to skip setting a TTL
 *
 * Returns the new integer value of the counter.
 */
const INCR_WITH_TTL_SCRIPT = `
local val = redis.call('INCR', KEYS[1])
local ttl = tonumber(ARGV[1])
if ttl and ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
end
return val
`;

export function createRedisCacheService(redisUrl: string): CacheService {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore - optional dependency, loaded only when redisUrl is present
  const { createClient } = require('redis') as {
    createClient: (opts: { url: string }) => {
      connect: () => Promise<void>;
      get: (key: string) => Promise<string | null>;
      set: (key: string, value: string, opts: any) => Promise<void>;
      del: (key: string) => Promise<number>;
      incr: (key: string) => Promise<number>;
      expire: (key: string, seconds: number) => Promise<number>;
      /**
       * Executes a Lua script on the Redis server.
       * Signature matches the node-redis v4 `eval` command.
       */
      eval: (
        script: string,
        opts: { keys: string[]; arguments: string[] },
      ) => Promise<unknown>;
    };
  };

  class RedisCache implements CacheService {
    private client = createClient({ url: redisUrl });
    private connected = false;

    private async ensureConnected() {
      if (this.connected) return;
      await this.client.connect();
      this.connected = true;
    }

    async getJSON<T>(key: string): Promise<{ value: T } | null> {
      await this.ensureConnected();
      const raw = await this.client.get(key);
      if (!raw) return null;
      return { value: JSON.parse(raw) as T };
    }

    async setJSON<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      await this.ensureConnected();
      await this.client.set(key, JSON.stringify(value), {
        EX: ttlSeconds,
      });
    }

    async del(key: string): Promise<void> {
      await this.ensureConnected();
      await this.client.del(key);
    }

    /**
     * Atomically increments the version counter at `key` and, when
     * `ttlSeconds` is provided, sets its expiry — all in a single Lua script
     * executed via EVAL so there is no window where the key can exist without
     * a TTL (fixes issue #126).
     */
    async incr(key: string, ttlSeconds?: number): Promise<number> {
      await this.ensureConnected();
      const ttlArg = ttlSeconds && ttlSeconds > 0 ? String(ttlSeconds) : '0';
      const result = await this.client.eval(INCR_WITH_TTL_SCRIPT, {
        keys: [key],
        arguments: [ttlArg],
      });
      return Number(result);
    }

    async getIncr(key: string): Promise<number | null> {
      await this.ensureConnected();
      const raw = await this.client.get(key);
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
  }

  return new RedisCache();
}

export function createDefaultCacheService(
  enabled: boolean,
  redisUrl?: string,
): CacheService {
  if (!enabled) return new NoopCacheService();
  if (!redisUrl) return new NoopCacheService();
  return createRedisCacheService(redisUrl);
}

