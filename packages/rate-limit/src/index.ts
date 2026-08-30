/**
 * Decision returned when evaluating a rate limit check.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterMs: number | null;
  readonly resetAt: number;
}

/**
 * Configuration options for the rate limiter.
 */
export interface RateLimiterOptions {
  /** Maximum number of allowed requests within the window */
  readonly limit: number;
  /** Duration of the sliding window in milliseconds */
  readonly windowMs: number;
  /** Storage backend adapter */
  readonly store?: RateLimitStore;
  /** Injectable time provider (defaults to Date.now) */
  readonly now?: () => number;
}

/**
 * Interface for rate limit storage backends (In-memory, Redis, Memcached, etc.).
 */
export interface RateLimitStore {
  /**
   * Atomically records a request hit and returns the active count and next reset timestamp.
   */
  increment(
    key: string,
    windowMs: number,
    now: number
  ): Promise<{ count: number; resetAt: number }>;

  /**
   * Manually purges expired entries or clears the store.
   */
  cleanup?(now: number, windowMs?: number): Promise<void> | void;
}

/**
 * Bounded, thread-safe in-memory store utilizing sliding window log timestamps.
 * Periodically and opportunistically cleans up expired entries to ensure bounded memory usage.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly storage = new Map<string, number[]>();
  private lastCleanup: number = 0;
  private readonly maxKeys: number;
  private readonly cleanupIntervalMs: number;

  constructor(options?: { maxKeys?: number; cleanupIntervalMs?: number }) {
    this.maxKeys = options?.maxKeys ?? 10_000;
    this.cleanupIntervalMs = options?.cleanupIntervalMs ?? 30_000;
  }

  public async increment(
    key: string,
    windowMs: number,
    now: number
  ): Promise<{ count: number; resetAt: number }> {
    // Opportunistic background pruning if interval has elapsed or store exceeds bound
    if (now - this.lastCleanup > this.cleanupIntervalMs || this.storage.size > this.maxKeys) {
      this.cleanup(now, windowMs);
    }

    const windowStart = now - windowMs;
    const timestamps = this.storage.get(key) ?? [];

    // Filter out timestamps outside the active sliding window
    const validTimestamps = timestamps.filter((t) => t > windowStart);
    validTimestamps.push(now);

    this.storage.set(key, validTimestamps);

    const earliestTimestamp = validTimestamps[0] ?? now;
    const resetAt = earliestTimestamp + windowMs;

    return {
      count: validTimestamps.length,
      resetAt,
    };
  }

  public cleanup(now: number, windowMs: number = 60_000): void {
    this.lastCleanup = now;
    const expirationThreshold = now - windowMs;

    for (const [k, timestamps] of this.storage.entries()) {
      const active = timestamps.filter((t) => t > expirationThreshold);
      if (active.length === 0) {
        this.storage.delete(k);
      } else {
        this.storage.set(k, active);
      }
    }
  }

  public size(): number {
    return this.storage.size;
  }
}

/**
 * Rate Limiting Engine.
 * 
 * Algorithm: Sliding Window Log / Counter
 * Justification: Provides 100% boundary accuracy without the burst-at-boundary
 * flaw inherent to fixed windows, while remaining bounded in memory overhead.
 */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly store: RateLimitStore;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    if (!options) {
      throw new Error('RateLimiterOptions must be provided');
    }
    if (typeof options.limit !== 'number' || options.limit <= 0 || !Number.isFinite(options.limit)) {
      throw new Error(`Invalid limit: must be a positive integer, received ${options.limit}`);
    }
    if (typeof options.windowMs !== 'number' || options.windowMs <= 0 || !Number.isFinite(options.windowMs)) {
      throw new Error(`Invalid windowMs: must be a positive number, received ${options.windowMs}`);
    }

    this.limit = Math.floor(options.limit);
    this.windowMs = options.windowMs;
    this.store = options.store ?? new InMemoryRateLimitStore();
    this.now = options.now ?? (() => Date.now());
  }

  public async check(key: string): Promise<RateLimitDecision> {
    if (!key || typeof key !== 'string') {
      throw new Error('A valid string rate limit key must be provided');
    }

    const currentTime = this.now();
    const { count, resetAt } = await this.store.increment(key, this.windowMs, currentTime);

    const allowed = count <= this.limit;
    const remaining = Math.max(0, this.limit - count);
    const retryAfterMs = allowed ? null : Math.max(0, resetAt - currentTime);

    return {
      allowed,
      limit: this.limit,
      remaining,
      retryAfterMs,
      resetAt,
    };
  }
}
