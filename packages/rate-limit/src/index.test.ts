import { describe, it, expect } from 'vitest';
import { RateLimiter, InMemoryRateLimitStore } from './index';

describe('RateLimiter Engine', () => {
  it('rejects invalid configurations', () => {
    expect(() => new RateLimiter({ limit: -1, windowMs: 1000 })).toThrow(/Invalid limit/);
    expect(() => new RateLimiter({ limit: 0, windowMs: 1000 })).toThrow(/Invalid limit/);
    expect(() => new RateLimiter({ limit: 5, windowMs: 0 })).toThrow(/Invalid windowMs/);
    expect(() => new RateLimiter({ limit: 5, windowMs: -500 })).toThrow(/Invalid windowMs/);
    // @ts-expect-error test invalid options object
    expect(() => new RateLimiter(null)).toThrow();
  });

  it('allows requests within limit and exposes remaining capacity', async () => {
    let mockTime = 1_000_000;
    const limiter = new RateLimiter({
      limit: 3,
      windowMs: 10_000,
      now: () => mockTime,
    });

    const d1 = await limiter.check('user-1');
    expect(d1.allowed).toBe(true);
    expect(d1.remaining).toBe(2);
    expect(d1.retryAfterMs).toBeNull();
    expect(d1.limit).toBe(3);

    const d2 = await limiter.check('user-1');
    expect(d2.allowed).toBe(true);
    expect(d2.remaining).toBe(1);

    const d3 = await limiter.check('user-1');
    expect(d3.allowed).toBe(true);
    expect(d3.remaining).toBe(0);

    // 4th request exceeds limit
    const d4 = await limiter.check('user-1');
    expect(d4.allowed).toBe(false);
    expect(d4.remaining).toBe(0);
    expect(d4.retryAfterMs).toBe(10_000);
  });

  it('resets capacity as time advances past the sliding window', async () => {
    let mockTime = 1000;
    const limiter = new RateLimiter({
      limit: 2,
      windowMs: 1000,
      now: () => mockTime,
    });

    await limiter.check('ip-1');
    const second = await limiter.check('ip-1');
    expect(second.remaining).toBe(0);

    const third = await limiter.check('ip-1');
    expect(third.allowed).toBe(false);

    // Advance mock time past the window
    mockTime += 1001;

    const afterWindow = await limiter.check('ip-1');
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.remaining).toBe(1);
  });

  it('safely evaluates concurrent requests against the same key', async () => {
    let mockTime = 5000;
    const limiter = new RateLimiter({
      limit: 5,
      windowMs: 5000,
      now: () => mockTime,
    });

    const results = await Promise.all(
      Array.from({ length: 8 }).map(() => limiter.check('concurrent-key'))
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    const deniedCount = results.filter((r) => !r.allowed).length;

    expect(allowedCount).toBe(5);
    expect(deniedCount).toBe(3);
  });

  it('isolates different keys independently', async () => {
    let mockTime = 1000;
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 1000,
      now: () => mockTime,
    });

    const keyA1 = await limiter.check('keyA');
    const keyB1 = await limiter.check('keyB');

    expect(keyA1.allowed).toBe(true);
    expect(keyB1.allowed).toBe(true);

    const keyA2 = await limiter.check('keyA');
    expect(keyA2.allowed).toBe(false);
  });

  it('cleans up expired entries and bounds in-memory growth', async () => {
    let mockTime = 1000;
    const store = new InMemoryRateLimitStore({ cleanupIntervalMs: 500 });
    const limiter = new RateLimiter({
      limit: 2,
      windowMs: 1000,
      store,
      now: () => mockTime,
    });

    await limiter.check('temp-key-1');
    await limiter.check('temp-key-2');
    expect(store.size()).toBe(2);

    // Advance time and trigger cleanup
    mockTime += 2000;
    store.cleanup(mockTime, 1000);

    expect(store.size()).toBe(0);
  });
});
