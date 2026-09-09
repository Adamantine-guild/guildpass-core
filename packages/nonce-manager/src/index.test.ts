import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NonceManager } from "./index.js";

describe("NonceManager", () => {
  describe("Nonce Generation", () => {
    it("generates nonces using cryptographically secure randomness", () => {
      const manager = new NonceManager();
      const nonce1 = manager.issue();
      const nonce2 = manager.issue();

      assert.notEqual(nonce1, nonce2, "Nonces should be unique");
      assert.ok(nonce1.length > 0, "Nonce should not be empty");
      assert.ok(nonce2.length > 0, "Nonce should not be empty");
    });

    it("generates nonces with sufficient configurable entropy", () => {
      const manager16 = new NonceManager({ nonceByteLength: 16 });
      const manager32 = new NonceManager({ nonceByteLength: 32 });
      const manager64 = new NonceManager({ nonceByteLength: 64 });

      const nonce16 = manager16.issue();
      const nonce32 = manager32.issue();
      const nonce64 = manager64.issue();

      // Base64url encoding: 4 chars per 3 bytes, rounded up
      assert.ok(nonce16.length >= 22, "16-byte nonce should have sufficient length");
      assert.ok(nonce32.length >= 43, "32-byte nonce should have sufficient length");
      assert.ok(nonce64.length >= 86, "64-byte nonce should have sufficient length");
    });

    it("encodes nonces using URL-safe format", () => {
      const manager = new NonceManager();
      const nonce = manager.issue();

      // Base64url uses - and _ instead of + and /, and no padding
      assert.ok(!nonce.includes("+"), "Nonce should not contain +");
      assert.ok(!nonce.includes("/"), "Nonce should not contain /");
      assert.ok(!nonce.includes("="), "Nonce should not contain padding");
      assert.ok(nonce.match(/^[A-Za-z0-9_-]+$/), "Nonce should only contain URL-safe characters");
    });
  });

  describe("Issue and Validate", () => {
    it("validates newly issued nonce successfully before expiry", () => {
      const manager = new NonceManager();
      const nonce = manager.issue({ ttlMs: 5000, now: 1000 });

      const result = manager.validate(nonce, 1000);
      assert.equal(result.status, "valid");
    });

    it("rejects unknown nonces", () => {
      const manager = new NonceManager();
      const result = manager.validate("unknown_nonce");

      assert.equal(result.status, "unknown");
    });

    it("rejects expired nonces", () => {
      const manager = new NonceManager();
      const nonce = manager.issue({ ttlMs: 1000, now: 1000 });

      const result = manager.validate(nonce, 2000);
      assert.equal(result.status, "expired");

      // Verify expired record was cleaned up
      const validateAgain = manager.validate(nonce, 2000);
      assert.equal(validateAgain.status, "unknown");
    });
  });

  describe("Consume Operations", () => {
    it("consumes a valid nonce successfully", () => {
      const manager = new NonceManager();
      const nonce = manager.issue({ ttlMs: 5000, now: 1000 });

      const consumeResult = manager.consume(nonce, 1000);
      assert.equal(consumeResult.status, "valid");
    });

    it("prevents a consumed nonce from being consumed a second time", () => {
      const manager = new NonceManager();
      const nonce = manager.issue({ ttlMs: 5000, now: 1000 });

      const firstConsume = manager.consume(nonce, 1000);
      assert.equal(firstConsume.status, "valid");

      const secondConsume = manager.consume(nonce, 1000);
      assert.equal(secondConsume.status, "consumed");
    });

    it("validates consumed nonce as consumed without consuming it again", () => {
      const manager = new NonceManager();
      const nonce = manager.issue({ ttlMs: 5000, now: 1000 });

      manager.consume(nonce, 1000);
      const validateResult = manager.validate(nonce, 1000);

      assert.equal(validateResult.status, "consumed");
    });

    it("rejects consumed nonces", () => {
      const manager = new NonceManager();
      const nonce = manager.issue({ ttlMs: 5000, now: 1000 });

      manager.consume(nonce, 1000);
      const consumeResult = manager.consume(nonce, 1000);

      assert.equal(consumeResult.status, "consumed");
    });

    it("rejects unknown nonces during consume", () => {
      const manager = new NonceManager();
      const consumeResult = manager.consume("unknown_nonce");

      assert.equal(consumeResult.status, "unknown");
    });

    it("rejects expired nonces during consume", () => {
      const manager = new NonceManager();
      const nonce = manager.issue({ ttlMs: 1000, now: 1000 });

      const consumeResult = manager.consume(nonce, 2000);
      assert.equal(consumeResult.status, "expired");

      // Verify expired record was cleaned up
      const consumeAgain = manager.consume(nonce, 2000);
      assert.equal(consumeAgain.status, "unknown");
    });
  });

  describe("Concurrent Consumption", () => {
    it("handles concurrent consume attempts for the same nonce atomically", async () => {
      const manager = new NonceManager();
      const nonce = manager.issue({ ttlMs: 5000, now: 1000 });

      // Simulate concurrent consume attempts
      const results = await Promise.all([
        Promise.resolve(manager.consume(nonce, 1000)),
        Promise.resolve(manager.consume(nonce, 1000)),
        Promise.resolve(manager.consume(nonce, 1000)),
        Promise.resolve(manager.consume(nonce, 1000)),
        Promise.resolve(manager.consume(nonce, 1000)),
      ]);

      const validCount = results.filter((r) => r.status === "valid").length;
      const consumedCount = results.filter((r) => r.status === "consumed").length;

      assert.equal(validCount, 1, "Exactly one consume should succeed");
      assert.equal(consumedCount, 4, "All other attempts should return consumed status");
    });
  });

  describe("Expiry and Cleanup", () => {
    it("cleans up expired records automatically", () => {
      const manager = new NonceManager({ maxRecords: 100 });
      
      // Issue nonces at different times
      manager.issue({ ttlMs: 1000, now: 1000 }); // expires at 2000
      manager.issue({ ttlMs: 2000, now: 1000 }); // expires at 3000
      manager.issue({ ttlMs: 500, now: 1000 });  // expires at 1500

      assert.equal(manager.getRecordCount(), 3);

      // Trigger cleanup at t=1500 - only the 500ms TTL nonce should be expired
      const cleared = manager.clearExpired(1500);
      assert.equal(cleared, 1, "Should clear 1 expired record");
      assert.equal(manager.getRecordCount(), 2);
    });

    it("automatically cleans expired records when issuing new nonces", () => {
      const manager = new NonceManager({ maxRecords: 100 });
      
      manager.issue({ ttlMs: 1000, now: 1000 });
      manager.issue({ ttlMs: 500, now: 1000 });
      
      assert.equal(manager.getRecordCount(), 2);

      // Issue new nonce at t=1500 - should trigger cleanup
      manager.issue({ ttlMs: 1000, now: 1500 });
      
      assert.equal(manager.getRecordCount(), 2, "Expired records should be cleaned");
    });
  });

  describe("Memory Growth Constraints", () => {
    it("enforces maximum number of retained records", () => {
      const manager = new NonceManager({ maxRecords: 3 });

      manager.issue({ now: 1000 });
      manager.issue({ now: 1000 });
      manager.issue({ now: 1000 });
      assert.equal(manager.getRecordCount(), 3);

      // This should remove the oldest record
      manager.issue({ now: 1000 });
      assert.equal(manager.getRecordCount(), 3);
    });

    it("removes oldest record when at capacity", () => {
      const manager = new NonceManager({ maxRecords: 2 });

      const nonce1 = manager.issue({ now: 1000 });
      const nonce2 = manager.issue({ now: 1000 });
      
      // Both should be valid
      assert.equal(manager.validate(nonce1, 1000).status, "valid");
      assert.equal(manager.validate(nonce2, 1000).status, "valid");

      // Issue third nonce - should remove oldest (nonce1)
      const nonce3 = manager.issue({ now: 1000 });
      
      assert.equal(manager.getRecordCount(), 2);
      assert.equal(manager.validate(nonce1, 1000).status, "unknown");
      assert.equal(manager.validate(nonce2, 1000).status, "valid");
      assert.equal(manager.validate(nonce3, 1000).status, "valid");
    });

    it("prevents unbounded memory growth", () => {
      const manager = new NonceManager({ maxRecords: 5 });

      for (let i = 0; i < 100; i++) {
        manager.issue({ now: 1000 });
      }

      assert.equal(manager.getRecordCount(), 5, "Record count should not exceed maxRecords");
    });
  });

  describe("Time Injection for Testing", () => {
    it("allows time to be injected for deterministic tests", () => {
      let currentTime = 1000;
      const manager = new NonceManager({
        now: () => currentTime,
        defaultTtlMs: 1000,
      });

      const nonce = manager.issue();
      assert.equal(manager.validate(nonce).status, "valid");

      // Advance time to expiry
      currentTime = 2000;
      assert.equal(manager.validate(nonce).status, "expired");
    });

    it("supports controllable time in tests without long sleeps", () => {
      let currentTime = 1000;
      const manager = new NonceManager({
        now: () => currentTime,
        defaultTtlMs: 500,
      });

      const nonce = manager.issue({ now: currentTime });
      assert.equal(manager.validate(nonce, currentTime).status, "valid");

      // Advance time but still valid
      currentTime = 1200;
      assert.equal(manager.validate(nonce, currentTime).status, "valid");

      // Advance time past expiry
      currentTime = 1600;
      assert.equal(manager.validate(nonce, currentTime).status, "expired");
    });
  });

  describe("Configuration", () => {
    it("uses configurable default TTL", () => {
      const manager = new NonceManager({ defaultTtlMs: 1000 });
      const nonce = manager.issue({ now: 1000 });

      assert.equal(manager.validate(nonce, 1500).status, "valid");
      assert.equal(manager.validate(nonce, 2500).status, "expired");
    });

    it("overrides default TTL with custom TTL", () => {
      const manager = new NonceManager({ defaultTtlMs: 10000 });
      const nonce = manager.issue({ ttlMs: 500, now: 1000 });

      assert.equal(manager.validate(nonce, 1200).status, "valid");
      assert.equal(manager.validate(nonce, 1600).status, "expired");
    });

    it("uses configurable nonce byte length", () => {
      const manager = new NonceManager({ nonceByteLength: 16 });
      const nonce = manager.issue();

      // 16 bytes -> ~22 chars in base64url
      assert.ok(nonce.length >= 22);
      assert.ok(nonce.length <= 24);
    });
  });

  describe("Edge Cases", () => {
    it("handles rapid successive issues without issues", () => {
      const manager = new NonceManager();
      const nonces: string[] = [];

      for (let i = 0; i < 100; i++) {
        nonces.push(manager.issue());
      }

      // All nonces should be unique
      const uniqueNonces = new Set(nonces);
      assert.equal(uniqueNonces.size, 100);
    });

    it("validates after consume returns consumed status", () => {
      const manager = new NonceManager();
      const nonce = manager.issue();

      manager.consume(nonce);
      const validateResult = manager.validate(nonce);

      assert.equal(validateResult.status, "consumed");
    });

    it("handles cleanup when no expired records exist", () => {
      const manager = new NonceManager();
      manager.issue({ ttlMs: 10000, now: 1000 });
      manager.issue({ ttlMs: 10000, now: 1000 });

      const cleared = manager.clearExpired(1000);
      assert.equal(cleared, 0);
      assert.equal(manager.getRecordCount(), 2);
    });
  });
});
