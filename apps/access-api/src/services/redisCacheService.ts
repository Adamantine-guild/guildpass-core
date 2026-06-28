import type { CacheService } from './cacheService';
import { NoopCacheService } from './cacheService';

// Optional dependency: only used when redisUrl is configured.
// We keep it in a separate file to avoid loading redis libraries when disabled.

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

    async incr(key: string, ttlSeconds?: number): Promise<number> {
      await this.ensureConnected();
      const next = await this.client.incr(key);
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.expire(key, ttlSeconds);
      }
      return next;
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

