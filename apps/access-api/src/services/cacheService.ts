export type CacheGetResult<T> = { value: T } | null;

export interface CacheService {
  getJSON<T>(key: string): Promise<CacheGetResult<T>>;
  setJSON<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Atomically increments a version counter stored at `key`.
   *
   * Implementations must return the new value.
   */
  incr(key: string, ttlSeconds?: number): Promise<number>;
  /**
   * Returns current integer value for `key` or null if missing.
   */
  getIncr(key: string): Promise<number | null>;
}

export class NoopCacheService implements CacheService {
  async getJSON<T>(_key: string): Promise<CacheGetResult<T>> {
    return null;
  }
  async setJSON<T>(_key: string, _value: T, _ttlSeconds: number): Promise<void> {
    return;
  }
  async del(_key: string): Promise<void> {
    return;
  }
  async incr(_key: string, _ttlSeconds?: number): Promise<number> {
    return 1;
  }
  async getIncr(_key: string): Promise<number | null> {
    return null;
  }
}

/**
 * Simple in-memory cache for unit tests.
 */
export class InMemoryCacheService implements CacheService {
  private store = new Map<
    string,
    { value: unknown; expiresAt: number | null }
  >();
  private incrStore = new Map<string, { value: number; expiresAt: number | null }>();

  async getJSON<T>(key: string): Promise<CacheGetResult<T>> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return { value: entry.value as T };
  }

  async setJSON<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.incrStore.delete(key);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const existing = this.incrStore.get(key);
    const current = existing ? existing.value : 0;
    const next = current + 1;
    const expiresAt = ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    this.incrStore.set(key, { value: next, expiresAt });
    return next;
  }

  async getIncr(key: string): Promise<number | null> {
    const entry = this.incrStore.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.incrStore.delete(key);
      return null;
    }
    return entry.value;
  }
}

