import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IdempotencyEngine,
  InMemoryIdempotencyStore,
  InvalidIdempotencyKeyError,
  InvalidFingerprintError,
} from "./index.js";

describe("Concurrency-Safe Idempotency Engine", () => {
  it("executes the protected callback exactly once during concurrent requests", async () => {
    const store = new InMemoryIdempotencyStore();
    const engine = new IdempotencyEngine({ store });

    let executionCount = 0;
    const protectedFn = async () => {
      executionCount++;
      // Simulate async work delay
      await new Promise((res) => setTimeout(res, 50));
      return { memberId: "m_123", txHash: "0xabc" };
    };

    const key = "tx_key_001";
    const fingerprint = "fingerprint_abc";

    // Run 5 concurrent executions with exact same key & fingerprint
    const results = await Promise.all([
      engine.execute({ key, fingerprint, fn: protectedFn }),
      engine.execute({ key, fingerprint, fn: protectedFn }),
      engine.execute({ key, fingerprint, fn: protectedFn }),
      engine.execute({ key, fingerprint, fn: protectedFn }),
      engine.execute({ key, fingerprint, fn: protectedFn }),
    ]);

    assert.equal(executionCount, 1, "Protected function must be executed exactly once");

    const executedCount = results.filter((r) => r.status === "executed").length;
    const replayedCount = results.filter((r) => r.status === "replayed").length;

    assert.equal(executedCount, 1);
    assert.equal(replayedCount, 4);

    for (const res of results) {
      assert.deepEqual((res as any).result, { memberId: "m_123", txHash: "0xabc" });
    }
  });

  it("replays stored result for subsequent requests with matching key and fingerprint", async () => {
    const engine = new IdempotencyEngine();
    const key = "key_subsequent";
    const fingerprint = "fp_subsequent";

    const res1 = await engine.execute({
      key,
      fingerprint,
      fn: async () => ({ value: "first_result" }),
    });

    assert.equal(res1.status, "executed");
    assert.equal(res1.replayed, false);
    assert.deepEqual(res1.result, { value: "first_result" });

    const res2 = await engine.execute({
      key,
      fingerprint,
      fn: async () => ({ value: "second_result_should_not_run" }),
    });

    assert.equal(res2.status, "replayed");
    assert.equal(res2.replayed, true);
    assert.deepEqual(res2.result, { value: "first_result" });
  });

  it("returns conflict outcome when key is reused with a different fingerprint", async () => {
    const engine = new IdempotencyEngine();
    const key = "key_conflict";

    await engine.execute({
      key,
      fingerprint: "fingerprint_v1",
      fn: async () => "result1",
    });

    const conflictRes = await engine.execute({
      key,
      fingerprint: "fingerprint_v2_different",
      fn: async () => "result2",
    });

    assert.equal(conflictRes.status, "conflict");
    assert.ok(conflictRes.reason.includes("different"));
  });

  it("does not permanently poison the key if protected operation throws an error", async () => {
    const engine = new IdempotencyEngine();
    const key = "key_error_recovery";
    const fingerprint = "fp_error_recovery";

    let attempt = 0;
    const failingFn = async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error("Temporary network glitch");
      }
      return "recovered_success";
    };

    // First attempt fails
    await assert.rejects(
      async () => {
        await engine.execute({ key, fingerprint, fn: failingFn });
      },
      (err: any) => err.message === "Temporary network glitch"
    );

    // Second attempt succeeds because key was released upon failure
    const res = await engine.execute({ key, fingerprint, fn: failingFn });

    assert.equal(attempt, 2);
    assert.equal(res.status, "executed");
    assert.equal(res.result, "recovered_success");
  });

  it("respects TTL expiration without requiring long real-time sleeps", async () => {
    const store = new InMemoryIdempotencyStore();
    const engine = new IdempotencyEngine({ store });
    const key = "key_ttl";
    const fingerprint = "fp_ttl";

    let currentTime = 1000;
    const nowProvider = () => currentTime;

    // Execute at t=1000 with 500ms TTL (expires at t=1500)
    const res1 = await engine.execute({
      key,
      fingerprint,
      ttlMs: 500,
      now: nowProvider,
      fn: async () => "v1",
    });
    assert.equal(res1.status, "executed");

    // Call at t=1200 -> still valid -> replayed
    currentTime = 1200;
    const res2 = await engine.execute({
      key,
      fingerprint,
      ttlMs: 500,
      now: nowProvider,
      fn: async () => "v2_should_not_run",
    });
    assert.equal(res2.status, "replayed");
    assert.equal(res2.result, "v1");

    // Advance time to t=1600 -> expired -> executed fresh
    currentTime = 1600;
    const res3 = await engine.execute({
      key,
      fingerprint,
      ttlMs: 500,
      now: nowProvider,
      fn: async () => "v3_fresh",
    });
    assert.equal(res3.status, "executed");
    assert.equal(res3.result, "v3_fresh");
  });

  it("clears expired records from InMemoryIdempotencyStore", async () => {
    const store = new InMemoryIdempotencyStore();

    await store.acquire({ key: "k1", fingerprint: "fp1", ttlMs: 100, now: 1000 });
    await store.acquire({ key: "k2", fingerprint: "fp2", ttlMs: 1000, now: 1000 });

    const clearedAt1200 = await store.clearExpired(1200);
    assert.equal(clearedAt1200, 1, "Should clear 1 expired record");

    assert.equal(await store.get("k1", 1200), null);
    assert.ok((await store.get("k2", 1200)) !== null);
  });

  it("automatically generates fingerprint when payload object is passed", async () => {
    const engine = new IdempotencyEngine();
    const key = "key_object_fp";
    const payload = { b: 2, a: 1 };

    const res1 = await engine.execute({
      key,
      fingerprint: payload,
      fn: async () => "ok",
    });

    assert.equal(res1.status, "executed");

    // Same payload with different key order -> generates same canonical fingerprint -> replayed
    const res2 = await engine.execute({
      key,
      fingerprint: { a: 1, b: 2 },
      fn: async () => "nok",
    });

    assert.equal(res2.status, "replayed");
  });

  it("validates idempotency key and fingerprint inputs", async () => {
    const engine = new IdempotencyEngine();

    await assert.rejects(
      async () => {
        await engine.execute({ key: "", fingerprint: "fp", fn: async () => {} });
      },
      (err: any) => err instanceof InvalidIdempotencyKeyError
    );

    await assert.rejects(
      async () => {
        await engine.execute({ key: "k", fingerprint: "   ", fn: async () => {} });
      },
      (err: any) => err instanceof InvalidFingerprintError
    );
  });
});
