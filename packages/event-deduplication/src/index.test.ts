import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EventDeduplicationEngine,
  InvalidFingerprintError,
  type DeduplicationResult,
} from "./index.js";

describe("EventDeduplicationEngine", () => {
  describe("Basic Deduplication", () => {
    it("accepts a new fingerprint for processing", () => {
      const engine = new EventDeduplicationEngine();
      const result = engine.checkAndRecord("event_123");

      assert.equal(result.type, "first_seen");
      assert.equal(result.shouldProcess, true);
    });

    it("rejects a duplicate fingerprint inside retention window", () => {
      const engine = new EventDeduplicationEngine();
      const fingerprint = "event_123";

      const first = engine.checkAndRecord(fingerprint, { now: 1000 });
      assert.equal(first.type, "first_seen");

      const duplicate = engine.checkAndRecord(fingerprint, { now: 1000 });
      assert.equal(duplicate.type, "duplicate");
      assert.equal(duplicate.shouldProcess, false);
    });

    it("accepts an expired fingerprint again after retention window", () => {
      const engine = new EventDeduplicationEngine({ defaultRetentionMs: 1000 });
      const fingerprint = "event_123";

      const first = engine.checkAndRecord(fingerprint, { now: 1000 });
      assert.equal(first.type, "first_seen");

      // After expiry
      const afterExpiry = engine.checkAndRecord(fingerprint, { now: 2500 });
      assert.equal(afterExpiry.type, "first_seen");
      assert.equal(afterExpiry.shouldProcess, true);
    });

    it("rejects invalid fingerprints", () => {
      const engine = new EventDeduplicationEngine();

      const emptyResult = engine.checkAndRecord("");
      assert.equal(emptyResult.type, "error");
      assert.equal(emptyResult.shouldProcess, false);
      assert.ok(emptyResult.reason.includes("non-empty"));

      const whitespaceResult = engine.checkAndRecord("   ");
      assert.equal(whitespaceResult.type, "error");
      assert.equal(whitespaceResult.shouldProcess, false);
    });
  });

  describe("Atomic Check-and-Record", () => {
    it("atomically determines and records in single operation", () => {
      const engine = new EventDeduplicationEngine();
      const fingerprint = "event_atomic";

      const result = engine.checkAndRecord(fingerprint);
      assert.equal(result.type, "first_seen");
      assert.equal(engine.getRecordCount(), 1);
    });

    it("concurrent attempts using same fingerprint result in at most one first-seen", async () => {
      const engine = new EventDeduplicationEngine();
      const fingerprint = "event_concurrent";

      // Simulate concurrent attempts
      const results = await Promise.all([
        Promise.resolve(engine.checkAndRecord(fingerprint, { now: 1000 })),
        Promise.resolve(engine.checkAndRecord(fingerprint, { now: 1000 })),
        Promise.resolve(engine.checkAndRecord(fingerprint, { now: 1000 })),
        Promise.resolve(engine.checkAndRecord(fingerprint, { now: 1000 })),
        Promise.resolve(engine.checkAndRecord(fingerprint, { now: 1000 })),
      ]);

      const firstSeenCount = results.filter((r) => r.type === "first_seen").length;
      const duplicateCount = results.filter((r) => r.type === "duplicate").length;

      assert.equal(firstSeenCount, 1, "Exactly one should be first_seen");
      assert.equal(duplicateCount, 4, "All others should be duplicates");
    });
  });

  describe("Expiry and Cleanup", () => {
    it("cleans up expired entries automatically", () => {
      const engine = new EventDeduplicationEngine({ defaultRetentionMs: 1000 });

      engine.checkAndRecord("event_1", { now: 1000 }); // expires at 2000
      engine.checkAndRecord("event_2", { now: 1000 }); // expires at 2000
      engine.checkAndRecord("event_3", { now: 1000 }); // expires at 2000

      assert.equal(engine.getRecordCount(), 3);

      // Trigger cleanup at t=2500
      const cleared = engine.clearExpired(2500);
      assert.equal(cleared, 3);
      assert.equal(engine.getRecordCount(), 0);
    });

    it("automatically cleans expired entries on checkAndRecord", () => {
      const engine = new EventDeduplicationEngine({ defaultRetentionMs: 1000 });

      engine.checkAndRecord("event_1", { now: 1000 });
      engine.checkAndRecord("event_2", { now: 1000 });

      assert.equal(engine.getRecordCount(), 2);

      // New check at t=2500 should trigger cleanup
      engine.checkAndRecord("event_3", { now: 2500 });

      assert.equal(engine.getRecordCount(), 1);
    });

    it("treats expired fingerprints as new on subsequent checks", () => {
      const engine = new EventDeduplicationEngine({ defaultRetentionMs: 1000 });
      const fingerprint = "event_expiry";

      engine.checkAndRecord(fingerprint, { now: 1000 });

      // Still valid
      const stillValid = engine.check(fingerprint, 1500);
      assert.equal(stillValid.type, "duplicate");

      // Expired
      const expired = engine.check(fingerprint, 2500);
      assert.equal(expired.type, "first_seen");
    });
  });

  describe("Memory Constraints and Eviction", () => {
    it("enforces maximum retained entry limit", () => {
      const engine = new EventDeduplicationEngine({ maxEntries: 3 });

      engine.checkAndRecord("event_1", { now: 1000 });
      engine.checkAndRecord("event_2", { now: 1000 });
      engine.checkAndRecord("event_3", { now: 1000 });

      assert.equal(engine.getRecordCount(), 3);

      // This should trigger eviction
      engine.checkAndRecord("event_4", { now: 1000 });

      assert.equal(engine.getRecordCount(), 3);
    });

    it("evicts oldest entry when capacity is reached (FIFO)", () => {
      const engine = new EventDeduplicationEngine({ maxEntries: 2 });

      const event1 = engine.checkAndRecord("event_1", { now: 1000 });
      assert.equal(event1.type, "first_seen");

      const event2 = engine.checkAndRecord("event_2", { now: 1500 });
      assert.equal(event2.type, "first_seen");

      // This should evict event_1 (oldest)
      const event3 = engine.checkAndRecord("event_3", { now: 2000 });
      assert.equal(event3.type, "first_seen");

      assert.equal(engine.getRecordCount(), 2);

      // event_1 should no longer exist
      const check1 = engine.check("event_1", 2000);
      assert.equal(check1.type, "first_seen");

      // event_2 and event_3 should still exist
      const check2 = engine.check("event_2", 2000);
      assert.equal(check2.type, "duplicate");

      const check3 = engine.check("event_3", 2000);
      assert.equal(check3.type, "duplicate");
    });

    it("prevents unbounded memory growth", () => {
      const engine = new EventDeduplicationEngine({ maxEntries: 5 });

      for (let i = 0; i < 100; i++) {
        engine.checkAndRecord(`event_${i}`, { now: 1000 });
      }

      assert.equal(engine.getRecordCount(), 5);
    });

    it("has deterministic eviction behavior (oldest first)", () => {
      const engine = new EventDeduplicationEngine({ maxEntries: 3 });

      const events = ["a", "b", "c", "d", "e"];
      events.forEach((event, index) => {
        engine.checkAndRecord(event, { now: 1000 + index * 100 });
      });

      // Should have c, d, e (a and b evicted)
      assert.equal(engine.getRecordCount(), 3);
      assert.equal(engine.check("a", 1000).type, "first_seen");
      assert.equal(engine.check("b", 1000).type, "first_seen");
      assert.equal(engine.check("c", 1000).type, "duplicate");
      assert.equal(engine.check("d", 1000).type, "duplicate");
      assert.equal(engine.check("e", 1000).type, "duplicate");
    });
  });

  describe("Configuration", () => {
    it("uses configurable default retention window", () => {
      const engine = new EventDeduplicationEngine({ defaultRetentionMs: 500 });
      const fingerprint = "event_config";

      const first = engine.checkAndRecord(fingerprint, { now: 1000 });
      assert.equal(first.type, "first_seen");

      const duplicate = engine.checkAndRecord(fingerprint, { now: 1200 });
      assert.equal(duplicate.type, "duplicate");

      const expired = engine.checkAndRecord(fingerprint, { now: 1600 });
      assert.equal(expired.type, "first_seen");
    });

    it("overrides default retention with custom retention", () => {
      const engine = new EventDeduplicationEngine({ defaultRetentionMs: 10000 });
      const fingerprint = "event_custom";

      const first = engine.checkAndRecord(fingerprint, { retentionMs: 500, now: 1000 });
      assert.equal(first.type, "first_seen");

      const expired = engine.checkAndRecord(fingerprint, { retentionMs: 500, now: 1600 });
      assert.equal(expired.type, "first_seen");
    });
  });

  describe("Time Injection for Testing", () => {
    it("allows time to be injected for deterministic tests", () => {
      let currentTime = 1000;
      const engine = new EventDeduplicationEngine({
        now: () => currentTime,
        defaultRetentionMs: 1000,
      });

      const fingerprint = "event_time";

      const first = engine.checkAndRecord(fingerprint);
      assert.equal(first.type, "first_seen");

      // Still valid
      currentTime = 1500;
      const duplicate = engine.checkAndRecord(fingerprint);
      assert.equal(duplicate.type, "duplicate");

      // Expired
      currentTime = 2500;
      const expired = engine.checkAndRecord(fingerprint);
      assert.equal(expired.type, "first_seen");
    });

    it("supports controllable time without long sleeps", () => {
      let currentTime = 1000;
      const engine = new EventDeduplicationEngine({
        now: () => currentTime,
        defaultRetentionMs: 500,
      });

      const fingerprint = "event_fast";

      const first = engine.checkAndRecord(fingerprint, { now: currentTime });
      assert.equal(first.type, "first_seen");

      currentTime = 1200;
      const duplicate = engine.checkAndRecord(fingerprint, { now: currentTime });
      assert.equal(duplicate.type, "duplicate");

      currentTime = 1600;
      const expired = engine.checkAndRecord(fingerprint, { now: currentTime });
      assert.equal(expired.type, "first_seen");
    });
  });

  describe("Check Operation (Non-Recording)", () => {
    it("checks fingerprint without recording", () => {
      const engine = new EventDeduplicationEngine();
      const fingerprint = "event_check";

      const check1 = engine.check(fingerprint);
      assert.equal(check1.type, "first_seen");
      assert.equal(engine.getRecordCount(), 0);

      engine.checkAndRecord(fingerprint);
      const check2 = engine.check(fingerprint);
      assert.equal(check2.type, "duplicate");
    });

    it("handles expired fingerprints in check operation", () => {
      const engine = new EventDeduplicationEngine({ defaultRetentionMs: 1000 });
      const fingerprint = "event_check_expiry";

      engine.checkAndRecord(fingerprint, { now: 1000 });

      const valid = engine.check(fingerprint, 1500);
      assert.equal(valid.type, "duplicate");

      const expired = engine.check(fingerprint, 2500);
      assert.equal(expired.type, "first_seen");
    });

    it("validates fingerprints in check operation", () => {
      const engine = new EventDeduplicationEngine();

      const result = engine.check("");
      assert.equal(result.type, "error");
      assert.equal(result.shouldProcess, false);
    });
  });

  describe("Edge Cases", () => {
    it("handles rapid successive checks without issues", () => {
      const engine = new EventDeduplicationEngine();
      const fingerprints: string[] = [];

      for (let i = 0; i < 100; i++) {
        fingerprints.push(`event_${i}`);
      }

      // All should be first_seen
      const results = fingerprints.map((fp) => engine.checkAndRecord(fp));
      const firstSeenCount = results.filter((r) => r.type === "first_seen").length;

      assert.equal(firstSeenCount, 100);
    });

    it("handles special characters in fingerprints", () => {
      const engine = new EventDeduplicationEngine();

      const special = "event_with-special.chars_123";
      const result = engine.checkAndRecord(special);

      assert.equal(result.type, "first_seen");
    });

    it("handles very long fingerprints", () => {
      const engine = new EventDeduplicationEngine();
      const longFingerprint = "a".repeat(1000);

      const result = engine.checkAndRecord(longFingerprint);
      assert.equal(result.type, "first_seen");
    });

    it("clear operation removes all records", () => {
      const engine = new EventDeduplicationEngine();

      engine.checkAndRecord("event_1");
      engine.checkAndRecord("event_2");
      engine.checkAndRecord("event_3");

      assert.equal(engine.getRecordCount(), 3);

      engine.clear();
      assert.equal(engine.getRecordCount(), 0);

      const result = engine.checkAndRecord("event_1");
      assert.equal(result.type, "first_seen");
    });

    it("handles cleanup when no expired records exist", () => {
      const engine = new EventDeduplicationEngine();

      engine.checkAndRecord("event_1", { now: 1000 });
      engine.checkAndRecord("event_2", { now: 1000 });

      const cleared = engine.clearExpired(1000);
      assert.equal(cleared, 0);
      assert.equal(engine.getRecordCount(), 2);
    });
  });

  describe("Error Handling", () => {
    it("returns error result for null fingerprint", () => {
      const engine = new EventDeduplicationEngine();

      // @ts-expect-error - testing invalid input
      const result = engine.checkAndRecord(null);
      assert.equal(result.type, "error");
      assert.equal(result.shouldProcess, false);
    });

    it("returns error result for undefined fingerprint", () => {
      const engine = new EventDeduplicationEngine();

      // @ts-expect-error - testing invalid input
      const result = engine.checkAndRecord(undefined);
      assert.equal(result.type, "error");
      assert.equal(result.shouldProcess, false);
    });

    it("returns error result for non-string fingerprint", () => {
      const engine = new EventDeduplicationEngine();

      // @ts-expect-error - testing invalid input
      const result = engine.checkAndRecord(123);
      assert.equal(result.type, "error");
      assert.equal(result.shouldProcess, false);
    });
  });
});
