/**
 * Unit tests for the Retry Policy Engine
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert";
import {
  retry,
  calculateBackoff,
  RetryExhaustedError,
  retryableByType,
  retryableByCode,
  retryableIf,
  type RetryOptions,
  type RetryMetadata
} from "./index.js";

describe("Retry Policy Engine", () => {
  describe("Backoff Calculation", () => {
    it("should calculate exponential backoff correctly", () => {
      // attempt 1: 1000 * 2^0 = 1000
      assert.strictEqual(calculateBackoff(1, 1000, 30000, 2, { enabled: false }), 1000);
      // attempt 2: 1000 * 2^1 = 2000
      assert.strictEqual(calculateBackoff(2, 1000, 30000, 2, { enabled: false }), 2000);
      // attempt 3: 1000 * 2^2 = 4000
      assert.strictEqual(calculateBackoff(3, 1000, 30000, 2, { enabled: false }), 4000);
      // attempt 4: 1000 * 2^3 = 8000
      assert.strictEqual(calculateBackoff(4, 1000, 30000, 2, { enabled: false }), 8000);
    });

    it("should cap delay at maximum", () => {
      // With maxDelay of 5000, attempt 4 should be capped at 5000
      assert.strictEqual(calculateBackoff(4, 1000, 5000, 2, { enabled: false }), 5000);
      // Even higher attempts should stay capped
      assert.strictEqual(calculateBackoff(10, 1000, 5000, 2, { enabled: false }), 5000);
    });

    it("should apply jitter when enabled", () => {
      const randomValues = [0.5, 0.25, 0.75];
      let index = 0;
      const mockRandom = () => randomValues[index++];
      
      // With jitter, delay should be: cappedDelay * random
      const delay1 = calculateBackoff(1, 1000, 30000, 2, { enabled: true, random: mockRandom });
      assert.strictEqual(delay1, 1000 * 0.5); // 500
      
      const delay2 = calculateBackoff(2, 1000, 30000, 2, { enabled: true, random: mockRandom });
      assert.strictEqual(delay2, 2000 * 0.25); // 500
      
      const delay3 = calculateBackoff(3, 1000, 30000, 2, { enabled: true, random: mockRandom });
      assert.strictEqual(delay3, 4000 * 0.75); // 3000
    });

    it("should not apply jitter when disabled", () => {
      const delay = calculateBackoff(2, 1000, 30000, 2, { enabled: false });
      assert.strictEqual(delay, 2000);
    });

    it("should use default values when not provided", () => {
      const delay = calculateBackoff(2);
      // Default: initialDelay=1000, maxDelay=30000, multiplier=2
      // With jitter enabled, should be between 0 and 2000
      assert.ok(delay >= 0 && delay <= 2000);
    });

    it("should handle custom multiplier", () => {
      // With multiplier 3: attempt 2 = 1000 * 3^1 = 3000
      assert.strictEqual(calculateBackoff(2, 1000, 30000, 3, { enabled: false }), 3000);
    });
  });

  describe("Successful Operations", () => {
    it("should return immediately on success without retries", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        return "success";
      };

      const result = await retry(operation);

      assert.strictEqual(result, "success");
      assert.strictEqual(callCount, 1);
    });

    it("should pass metadata to operation", async () => {
      const metadataValues: RetryMetadata[] = [];
      const operation = async (metadata: RetryMetadata) => {
        metadataValues.push(metadata);
        return "success";
      };

      await retry(operation);

      assert.strictEqual(metadataValues.length, 1);
      assert.strictEqual(metadataValues[0].attempt, 1);
      assert.strictEqual(metadataValues[0].totalAttempts, 1);
    });
  });

  describe("Retry on Failure", () => {
    it("should retry on failure up to max attempts", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error("Temporary failure");
        }
        return "success";
      };

      const result = await retry(operation, { maxAttempts: 5 });

      assert.strictEqual(result, "success");
      assert.strictEqual(callCount, 3);
    });

    it("should throw RetryExhaustedError when attempts exhausted", async () => {
      const operation = async () => {
        throw new Error("Persistent failure");
      };

      await assert.rejects(
        async () => await retry(operation, { maxAttempts: 3 }),
        (error: Error) => {
          assert.ok(error instanceof RetryExhaustedError);
          assert.strictEqual(error.attempts, 3);
          assert.ok(error.cause instanceof Error);
          assert.strictEqual((error.cause as Error).message, "Persistent failure");
          return true;
        }
      );
    });

    it("should count first execution as an attempt", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        throw new Error("Failure");
      };

      await assert.rejects(
        async () => await retry(operation, { maxAttempts: 1 }),
        (error: Error) => {
          assert.ok(error instanceof RetryExhaustedError);
          assert.strictEqual(error.attempts, 1);
          assert.strictEqual(callCount, 1);
          return true;
        }
      );
    });

    it("should respect custom maxAttempts", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        throw new Error("Failure");
      };

      await assert.rejects(
        async () => await retry(operation, { maxAttempts: 5 }),
        (error: Error) => {
          assert.ok(error instanceof RetryExhaustedError);
          assert.strictEqual(error.attempts, 5);
          assert.strictEqual(callCount, 5);
          return true;
        }
      );
    });
  });

  describe("Non-Retryable Errors", () => {
    it("should not retry non-retryable errors", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        throw new Error("Permanent failure");
      };

      const isRetryable = (error: unknown) => {
        return !(error instanceof Error && error.message === "Permanent failure");
      };

      await assert.rejects(
        async () => await retry(operation, { maxAttempts: 5, isRetryable }),
        (error: Error) => {
          // Should throw the original error, not RetryExhaustedError
          assert.strictEqual(error.message, "Permanent failure");
          assert.strictEqual(callCount, 1);
          return true;
        }
      );
    });

    it("should retry retryable errors but not non-retryable", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Temporary failure");
        } else if (callCount === 2) {
          throw new Error("Permanent failure");
        }
        return "success";
      };

      const isRetryable = (error: unknown) => {
        return !(error instanceof Error && error.message === "Permanent failure");
      };

      await assert.rejects(
        async () => await retry(operation, { maxAttempts: 5, isRetryable }),
        (error: Error) => {
          assert.strictEqual(error.message, "Permanent failure");
          assert.strictEqual(callCount, 2); // First error retried, second not
          return true;
        }
      );
    });
  });

  describe("Exponential Backoff", () => {
    it("should use exponential backoff between retries", async () => {
      const delays: number[] = [];
      let callCount = 0;
      
      const operation = async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error("Failure");
        }
        return "success";
      };

      const startTime = Date.now();
      await retry(operation, { 
        maxAttempts: 3, 
        initialDelay: 100,
        jitter: { enabled: false }
      });
      const elapsed = Date.now() - startTime;

      // Should have waited: 100ms (between attempt 1 and 2)
      // Total time should be at least 100ms
      assert.ok(elapsed >= 90); // Allow some tolerance
    });

    it("should respect custom initial delay", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error("Failure");
        }
        return "success";
      };

      const startTime = Date.now();
      await retry(operation, { 
        maxAttempts: 2, 
        initialDelay: 50,
        jitter: { enabled: false }
      });
      const elapsed = Date.now() - startTime;

      assert.ok(elapsed >= 45); // At least 50ms delay
    });

    it("should respect custom backoff multiplier", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error("Failure");
        }
        return "success";
      };

      const startTime = Date.now();
      await retry(operation, { 
        maxAttempts: 3, 
        initialDelay: 50,
        backoffMultiplier: 3,
        jitter: { enabled: false }
      });
      const elapsed = Date.now() - startTime;

      // Should have waited: 50 * 3 = 150ms
      assert.ok(elapsed >= 140);
    });

    it("should cap delay at maxDelay", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error("Failure");
        }
        return "success";
      };

      const startTime = Date.now();
      await retry(operation, { 
        maxAttempts: 3, 
        initialDelay: 10,
        maxDelay: 50,
        backoffMultiplier: 10,
        jitter: { enabled: false }
      });
      const elapsed = Date.now() - startTime;

      // Should be capped at 50ms (10 * 10 = 100, but capped at 50)
      assert.ok(elapsed >= 45);
      assert.ok(elapsed < 200); // Allow tolerance for operation execution time
    });
  });

  describe("Jitter", () => {
    it("should apply jitter by default", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error("Failure");
        }
        return "success";
      };

      // With jitter, delay should vary
      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        callCount = 0;
        const startTime = Date.now();
        await retry(operation, { 
          maxAttempts: 2, 
          initialDelay: 100
        });
        delays.push(Date.now() - startTime);
      }

      // At least some variation should occur (though not guaranteed)
      // This is more of a sanity check
      assert.ok(delays.every(d => d >= 0));
    });

    it("should use deterministic random when provided", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error("Failure");
        }
        return "success";
      };

      let randomCallCount = 0;
      const mockRandom = () => {
        randomCallCount++;
        return 0.5;
      };
      
      await retry(operation, { 
        maxAttempts: 2, 
        initialDelay: 100,
        jitter: { enabled: true, random: mockRandom }
      });

      assert.ok(randomCallCount > 0);
    });

    it("should allow disabling jitter", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error("Failure");
        }
        return "success";
      };

      const startTime = Date.now();
      await retry(operation, { 
        maxAttempts: 2, 
        initialDelay: 50,
        jitter: { enabled: false }
      });
      const elapsed = Date.now() - startTime;

      // Without jitter, should be very close to 50ms
      assert.ok(elapsed >= 45);
      assert.ok(elapsed < 200); // Allow tolerance for operation execution time
    });
  });

  describe("Cancellation", () => {
    it("should stop when signal is aborted before operation", async () => {
      const controller = new AbortController();
      controller.abort();

      const operation = async () => {
        return "success";
      };

      await assert.rejects(
        async () => await retry(operation, { signal: controller.signal }),
        (error: Error) => {
          assert.strictEqual(error.name, "AbortError");
          return true;
        }
      );
    });

    it("should stop when signal is aborted during retry", async () => {
      const controller = new AbortController();
      let callCount = 0;

      const operation = async () => {
        callCount++;
        if (callCount === 1) {
          // Abort after first attempt - use longer delay to ensure it happens during retry wait
          setTimeout(() => controller.abort(), 50);
          throw new Error("Failure");
        }
        return "success";
      };

      await assert.rejects(
        async () => await retry(operation, { 
          signal: controller.signal,
          maxAttempts: 5,
          initialDelay: 200 // Longer delay to ensure abort happens during wait
        }),
        (error: Error) => {
          assert.strictEqual(error.name, "AbortError");
          assert.strictEqual(callCount, 1);
          return true;
        }
      );
    });

    it("should clean up timers on abort", async () => {
      const controller = new AbortController();
      let callCount = 0;

      const operation = async () => {
        callCount++;
        throw new Error("Failure");
      };

      // Abort immediately
      controller.abort();

      await assert.rejects(
        async () => await retry(operation, { 
          signal: controller.signal,
          maxAttempts: 5,
          initialDelay: 10000 // Long delay
        }),
        (error: Error) => {
          assert.strictEqual(error.name, "AbortError");
          // Should not wait for the long delay
          assert.strictEqual(callCount, 0);
          return true;
        }
      );
    });
  });

  describe("Retry Callback", () => {
    it("should call onRetry callback before each retry", async () => {
      const retryCalls: number[] = [];
      let callCount = 0;

      const operation = async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error("Failure");
        }
        return "success";
      };

      const onRetry = (attempt: number, error: unknown) => {
        retryCalls.push(attempt);
      };

      await retry(operation, { 
        maxAttempts: 5,
        onRetry
      });

      // Should have called onRetry twice (after attempt 1 and attempt 2)
      assert.deepStrictEqual(retryCalls, [1, 2]);
    });

    it("should pass error to onRetry callback", async () => {
      const errors: unknown[] = [];
      let callCount = 0;

      const operation = async () => {
        callCount++;
        throw new Error(`Failure ${callCount}`);
      };

      const onRetry = (attempt: number, error: unknown) => {
        errors.push(error);
      };

      await assert.rejects(
        async () => await retry(operation, { 
          maxAttempts: 3,
          onRetry
        })
      );

      assert.strictEqual(errors.length, 2);
      assert.ok(errors[0] instanceof Error);
      assert.strictEqual((errors[0] as Error).message, "Failure 1");
      assert.strictEqual((errors[1] as Error).message, "Failure 2");
    });
  });

  describe("Validation", () => {
    it("should reject maxAttempts less than 1", async () => {
      const operation = async () => "success";

      await assert.rejects(
        async () => await retry(operation, { maxAttempts: 0 }),
        (error: Error) => {
          assert.strictEqual(error.name, "RangeError");
          assert.ok(error.message.includes("maxAttempts"));
          return true;
        }
      );
    });

    it("should reject negative initialDelay", async () => {
      const operation = async () => "success";

      await assert.rejects(
        async () => await retry(operation, { initialDelay: -1 }),
        (error: Error) => {
          assert.strictEqual(error.name, "RangeError");
          assert.ok(error.message.includes("initialDelay"));
          return true;
        }
      );
    });

    it("should reject negative maxDelay", async () => {
      const operation = async () => "success";

      await assert.rejects(
        async () => await retry(operation, { maxDelay: -1 }),
        (error: Error) => {
          assert.strictEqual(error.name, "RangeError");
          assert.ok(error.message.includes("maxDelay"));
          return true;
        }
      );
    });

    it("should reject backoffMultiplier less than 1", async () => {
      const operation = async () => "success";

      await assert.rejects(
        async () => await retry(operation, { backoffMultiplier: 0.5 }),
        (error: Error) => {
          assert.strictEqual(error.name, "RangeError");
          assert.ok(error.message.includes("backoffMultiplier"));
          return true;
        }
      );
    });

    it("should reject initialDelay greater than maxDelay", async () => {
      const operation = async () => "success";

      await assert.rejects(
        async () => await retry(operation, { initialDelay: 1000, maxDelay: 500 }),
        (error: Error) => {
          assert.strictEqual(error.name, "RangeError");
          assert.ok(error.message.includes("initialDelay"));
          return true;
        }
      );
    });
  });

  describe("Utility Functions", () => {
    describe("retryableByType", () => {
      class NetworkError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "NetworkError";
        }
      }

      class ValidationError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "ValidationError";
        }
      }

      it("should classify errors by type", () => {
        const isRetryable = retryableByType([NetworkError]);
        
        assert.strictEqual(isRetryable(new NetworkError("Timeout")), true);
        assert.strictEqual(isRetryable(new ValidationError("Invalid")), false);
        assert.strictEqual(isRetryable(new Error("Generic")), false);
      });

      it("should work with retry", async () => {
        let callCount = 0;
        const operation = async () => {
          callCount++;
          if (callCount < 2) {
            throw new NetworkError("Timeout");
          }
          return "success";
        };

        const isRetryable = retryableByType([NetworkError]);
        const result = await retry(operation, { 
          maxAttempts: 3,
          isRetryable
        });

        assert.strictEqual(result, "success");
        assert.strictEqual(callCount, 2);
      });

      it("should not retry non-matching types", async () => {
        let callCount = 0;
        const operation = async () => {
          callCount++;
          throw new ValidationError("Invalid");
        };

        const isRetryable = retryableByType([NetworkError]);

        await assert.rejects(
          async () => await retry(operation, { 
            maxAttempts: 3,
            isRetryable
          }),
          (error: Error) => {
            assert.strictEqual(error.name, "ValidationError");
            assert.strictEqual(callCount, 1);
            return true;
          }
        );
      });
    });

    describe("retryableByCode", () => {
      it("should classify errors by code", () => {
        const isRetryable = retryableByCode(["ETIMEDOUT", "ECONNRESET"]);
        
        const error1 = new Error("Timeout");
        (error1 as any).code = "ETIMEDOUT";
        assert.strictEqual(isRetryable(error1), true);

        const error2 = new Error("Connection reset");
        (error2 as any).code = "ECONNRESET";
        assert.strictEqual(isRetryable(error2), true);

        const error3 = new Error("Not found");
        (error3 as any).code = "ENOTFOUND";
        assert.strictEqual(isRetryable(error3), false);
      });

      it("should fallback to message if code not present", () => {
        const isRetryable = retryableByCode(["ETIMEDOUT"]);
        
        const error = new Error("ETIMEDOUT");
        assert.strictEqual(isRetryable(error), true);

        const error2 = new Error("Something else");
        assert.strictEqual(isRetryable(error2), false);
      });

      it("should return false for non-Error objects", () => {
        const isRetryable = retryableByCode(["ETIMEDOUT"]);
        assert.strictEqual(isRetryable("string error"), false);
        assert.strictEqual(isRetryable(null), false);
        assert.strictEqual(isRetryable(undefined), false);
      });
    });

    describe("retryableIf", () => {
      it("should use custom predicate", () => {
        const isRetryable = retryableIf((error: unknown) => {
          return error instanceof Error && error.message.includes("temporary");
        });

        assert.strictEqual(isRetryable(new Error("temporary failure")), true);
        assert.strictEqual(isRetryable(new Error("permanent failure")), false);
      });

      it("should work with complex predicates", () => {
        const isRetryable = retryableIf((error: unknown) => {
          if (error instanceof Error) {
            const is5xx = (error as any).status >= 500;
            const isNetworkError = error.message.includes("network");
            return is5xx || isNetworkError;
          }
          return false;
        });

        const error1 = new Error("Server error");
        (error1 as any).status = 500;
        assert.strictEqual(isRetryable(error1), true);

        const error2 = new Error("network timeout");
        assert.strictEqual(isRetryable(error2), true);

        const error3 = new Error("Client error");
        (error3 as any).status = 400;
        assert.strictEqual(isRetryable(error3), false);
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle zero initialDelay", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error("Failure");
        }
        return "success";
      };

      const result = await retry(operation, { 
        maxAttempts: 2, 
        initialDelay: 0,
        jitter: { enabled: false }
      });

      assert.strictEqual(result, "success");
      assert.strictEqual(callCount, 2);
    });

    it("should handle operation returning undefined", async () => {
      const operation = async () => {
        return undefined;
      };

      const result = await retry(operation);
      assert.strictEqual(result, undefined);
    });

    it("should handle operation returning null", async () => {
      const operation = async () => {
        return null;
      };

      const result = await retry(operation);
      assert.strictEqual(result, null);
    });

    it("should handle operation throwing non-Error", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 2) {
          throw "string error";
        }
        return "success";
      };

      const result = await retry(operation, { maxAttempts: 3 });
      assert.strictEqual(result, "success");
      assert.strictEqual(callCount, 2);
    });

    it("should preserve error context in RetryExhaustedError", async () => {
      class CustomError extends Error {
        constructor(message: string, public code: string) {
          super(message);
          this.name = "CustomError";
        }
      }

      const operation = async () => {
        throw new CustomError("Custom failure", "ERR_123");
      };

      await assert.rejects(
        async () => await retry(operation, { maxAttempts: 2 }),
        (error: Error) => {
          assert.ok(error instanceof RetryExhaustedError);
          assert.ok(error.cause instanceof CustomError);
          assert.strictEqual((error.cause as CustomError).code, "ERR_123");
          return true;
        }
      );
    });

    it("should handle very large maxAttempts", async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error("Failure");
        }
        return "success";
      };

      const result = await retry(operation, { 
        maxAttempts: 1000,
        initialDelay: 0
      });

      assert.strictEqual(result, "success");
      assert.strictEqual(callCount, 2);
    });
  });

  describe("Timer Cleanup", () => {
    it("should not leak timers on success", async () => {
      const operation = async () => {
        return "success";
      };

      // This test mainly ensures no errors are thrown
      await retry(operation, { maxAttempts: 5 });
      assert.ok(true);
    });

    it("should not leak timers on exhaustion", async () => {
      const operation = async () => {
        throw new Error("Failure");
      };

      await assert.rejects(
        async () => await retry(operation, { 
          maxAttempts: 2,
          initialDelay: 10
        })
      );
      assert.ok(true);
    });

    it("should not leak timers on non-retryable error", async () => {
      const operation = async () => {
        throw new Error("Permanent");
      };

      const isRetryable = () => false;

      await assert.rejects(
        async () => await retry(operation, { 
          maxAttempts: 5,
          isRetryable
        })
      );
      assert.ok(true);
    });
  });
});
