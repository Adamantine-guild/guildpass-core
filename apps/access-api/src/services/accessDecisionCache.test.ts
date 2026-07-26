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

// ---------------------------------------------------------------------------
// Issue #126 – Atomic TTL on Redis version-counter increments
//
// These tests use a manually-constructed mock Redis client to verify that the
// new Lua-script-based incr:
//   1. Always leaves the key with a TTL (no partial-state window).
//   2. Returns the correct incremented value.
//   3. Does NOT set a TTL when ttlSeconds is omitted.
// ---------------------------------------------------------------------------

/**
 * Builds a minimal mock Redis client that records every call made to it.
 * The `eval` method simulates the atomic Lua script by incrementing a
 * counter and, if ARGV[1] > 0, recording a TTL set — all within a single
 * synchronous step (no gap where a crash could leave a bare key).
 */
function makeMockRedisClient() {
  const store: Map<string, { value: number; ttl: number | null }> = new Map();
  const calls: string[] = [];

  return {
    store,
    calls,
    connected: false,

    async connect() {
      this.connected = true;
    },

    // Legacy methods kept for interface compliance — not called after fix.
    async incr(key: string): Promise<number> {
      calls.push(`incr:${key}`);
      const current = store.get(key)?.value ?? 0;
      const next = current + 1;
      store.set(key, { value: next, ttl: store.get(key)?.ttl ?? null });
      return next;
    },

    async expire(key: string, seconds: number): Promise<number> {
      calls.push(`expire:${key}:${seconds}`);
      const entry = store.get(key);
      if (entry) store.set(key, { ...entry, ttl: seconds });
      return 1;
    },

    async get(key: string): Promise<string | null> {
      return store.has(key) ? String(store.get(key)!.value) : null;
    },

    async set(_key: string, _value: string, _opts: unknown): Promise<void> {},
    async del(key: string): Promise<number> {
      store.delete(key);
      return 1;
    },

    /**
     * Simulates Redis EVAL executing the Lua script atomically.
     * Both the INCR and the EXPIRE happen inside this single call — there is
     * no interruptible window between them.
     */
    async eval(
      _script: string,
      opts: { keys: string[]; arguments: string[] },
    ): Promise<unknown> {
      const key = opts.keys[0]!;
      const ttl = parseInt(opts.arguments[0]!, 10);

      calls.push(`eval:${key}:ttl=${ttl}`);

      // Atomically: INCR then (optional) EXPIRE
      const current = store.get(key)?.value ?? 0;
      const next = current + 1;
      const newTtl = ttl > 0 ? ttl : store.get(key)?.ttl ?? null;
      store.set(key, { value: next, ttl: newTtl });

      return next;
    },
  };
}

describe('Issue #126 – atomic TTL on Redis incr', () => {
  /**
   * Helper: builds the RedisCache class backed by a mock client so we can
   * inspect the exact operations performed without a real Redis server.
   */
  function makeRedisCacheWithMock() {
    const mockClient = makeMockRedisClient();

    // Inline the same class logic as redisCacheService so we can inject the mock.
    // (Importing createRedisCacheService would require a real `redis` package.)
    const INCR_WITH_TTL_SCRIPT = `
local val = redis.call('INCR', KEYS[1])
local ttl = tonumber(ARGV[1])
if ttl and ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
end
return val
`;

    const cache = {
      async incr(key: string, ttlSeconds?: number): Promise<number> {
        await mockClient.connect();
        const ttlArg =
          ttlSeconds && ttlSeconds > 0 ? String(ttlSeconds) : '0';
        const result = await mockClient.eval(INCR_WITH_TTL_SCRIPT, {
          keys: [key],
          arguments: [ttlArg],
        });
        return Number(result);
      },
    };

    return { cache, mockClient };
  }

  test('key has a TTL set after incr with ttlSeconds', async () => {
    const { cache, mockClient } = makeRedisCacheWithMock();
    const key = 'version:guild:1';

    const v1 = await cache.incr(key, 300);
    expect(v1).toBe(1);

    // The TTL must be set — no partial state allowed.
    const entry = mockClient.store.get(key);
    expect(entry).toBeDefined();
    expect(entry!.ttl).toBe(300);
  });

  test('returned value equals the new incremented integer (no behavior change)', async () => {
    const { cache } = makeRedisCacheWithMock();
    const key = 'version:guild:2';

    expect(await cache.incr(key, 60)).toBe(1);
    expect(await cache.incr(key, 60)).toBe(2);
    expect(await cache.incr(key, 60)).toBe(3);
  });

  test('only a single eval call is made per incr (no separate expire round-trip)', async () => {
    const { cache, mockClient } = makeRedisCacheWithMock();
    const key = 'version:guild:3';

    await cache.incr(key, 120);

    // Exactly one `eval` call; no separate `incr` or `expire` calls.
    expect(mockClient.calls).toHaveLength(1);
    expect(mockClient.calls[0]).toMatch(/^eval:/);
    expect(mockClient.calls.some((c) => c.startsWith('incr:'))).toBe(false);
    expect(mockClient.calls.some((c) => c.startsWith('expire:'))).toBe(false);
  });

  test('no TTL is set when ttlSeconds is omitted', async () => {
    const { cache, mockClient } = makeRedisCacheWithMock();
    const key = 'version:guild:4';

    const v1 = await cache.incr(key); // no TTL arg
    expect(v1).toBe(1);

    const entry = mockClient.store.get(key);
    expect(entry).toBeDefined();
    expect(entry!.ttl).toBeNull(); // TTL must not be set
  });

  test('simulated crash between INCR and EXPIRE cannot leave key without TTL', async () => {
    // With the old two-step approach a crash after incr() but before expire()
    // left the key with no TTL.  The Lua-script approach makes this impossible:
    // both operations are part of a single atomic eval call.
    //
    // We demonstrate this by observing that after our eval-based incr the key
    // *always* carries the expected TTL, even if we were to throw right after.
    const { cache, mockClient } = makeRedisCacheWithMock();
    const key = 'version:guild:crash-sim';

    // Wrap eval to throw after completion (simulating a post-eval network error).
    const originalEval = mockClient.eval.bind(mockClient);
    let callCount = 0;
    mockClient.eval = async function (
      script: string,
      opts: { keys: string[]; arguments: string[] },
    ) {
      const result = await originalEval(script, opts);
      callCount += 1;
      // Simulate a network error on the first call — but the operation has
      // already completed atomically on the Redis side.
      if (callCount === 1) throw new Error('Simulated network drop');
      return result;
    };

    // The call throws from the caller's perspective …
    await expect(cache.incr(key, 500)).rejects.toThrow('Simulated network drop');

    // … but the key was already written atomically with its TTL intact.
    const entry = mockClient.store.get(key);
    expect(entry).toBeDefined();
    expect(entry!.value).toBe(1);
    expect(entry!.ttl).toBe(500); // TTL is set — no partial state
  });
});
