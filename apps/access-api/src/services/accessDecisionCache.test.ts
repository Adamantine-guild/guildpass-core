import { InMemoryCacheService } from './cacheService';

// Note: This file is only intended for local verification of cache
// primitives. The repo's Jest runner config currently points at
// apps/access-api/test, so these tests may be skipped in CI.

describe('Access decision cache primitives', () => {
  test('in-memory cache hit/miss and TTL expiry', async () => {
    const cache = new InMemoryCacheService();
    const key = 'k1';

    expect(await cache.getJSON<number>(key)).toBeNull();

    await cache.setJSON(key, 123, 1); // 1s TTL
    expect((await cache.getJSON<number>(key))?.value).toBe(123);

    // Wait slightly longer than TTL
    await new Promise((r) => setTimeout(r, 1100));
    expect(await cache.getJSON<number>(key)).toBeNull();
  });

  test('incr/getIncr increments with eviction when TTL expires', async () => {
    const cache = new InMemoryCacheService();
    const key = 'ver';

    expect(await cache.getIncr(key)).toBeNull();

    const v1 = await cache.incr(key, 1);
    expect(v1).toBe(1);

    expect(await cache.getIncr(key)).toBe(1);

    await new Promise((r) => setTimeout(r, 1100));
    expect(await cache.getIncr(key)).toBeNull();
  });
});


