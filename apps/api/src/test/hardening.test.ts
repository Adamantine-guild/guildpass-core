import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { issueToken } from "@guildpass/capability-token";
import { buildApp } from "../app.js";
import {
  GuildPassError,
  AuthenticationError,
  AuthorizationError,
  RateLimitExceededError,
  StellarTransactionError,
  sanitizeError,
} from "../errors/index.js";
import {
  classifyStellarError,
  StellarTransactionExecutor,
} from "../stellar/transaction-handler.js";
import { redact } from "@guildpass/log-redaction";
import { CircuitBreaker } from "@guildpass/circuit-breaker";

const TEST_SECRET = "test-secret-at-least-32-bytes-long-for-hmac";

function createValidToken(scopes: string[], subject = "user_test_123", ttl = 3600): string {
  return issueToken({
    subject,
    audience: "guildpass-core",
    scopes,
  }, {
    secret: TEST_SECRET,
    ttl,
  });
}

describe("GuildPass Core V2 Production Hardening", () => {
  describe("1. Mutation Authorization Boundaries", () => {
    it("rejects unauthenticated mutation requests with 401 AUTH_UNAUTHORIZED", async () => {
      const app = buildApp({ authSecret: TEST_SECRET });
      const res = await app.inject({
        method: "POST",
        url: "/api/v2/passes/issue",
        payload: { guildId: "alpha", passType: "vip" },
      });

      assert.equal(res.statusCode, 401);
      const body = res.json();
      assert.equal(body.error.code, "AUTH_UNAUTHORIZED");
      assert.ok(body.error.correlationId);
    });

    it("rejects requests with invalid/tampered token with 401", async () => {
      const app = buildApp({ authSecret: TEST_SECRET });
      const res = await app.inject({
        method: "POST",
        url: "/api/v2/passes/issue",
        headers: {
          authorization: "Bearer invalid.token.payload",
        },
        payload: { guildId: "alpha" },
      });

      assert.equal(res.statusCode, 401);
      const body = res.json();
      assert.equal(body.error.code, "AUTH_UNAUTHORIZED");
    });

    it("rejects authenticated caller lacking required scope with 403 AUTH_FORBIDDEN", async () => {
      const app = buildApp({ authSecret: TEST_SECRET });
      const tokenWithoutScope = createValidToken(["profile:read"]);

      const res = await app.inject({
        method: "POST",
        url: "/api/v2/passes/issue",
        headers: {
          authorization: `Bearer ${tokenWithoutScope}`,
        },
        payload: { guildId: "alpha" },
      });

      assert.equal(res.statusCode, 403);
      const body = res.json();
      assert.equal(body.error.code, "AUTH_FORBIDDEN");
      assert.ok(body.error.message.includes("pass:issue"));
    });

    it("authorizes mutation when valid token contains required scope", async () => {
      const app = buildApp({ authSecret: TEST_SECRET });
      const tokenWithScope = createValidToken(["pass:issue"]);

      const res = await app.inject({
        method: "POST",
        url: "/api/v2/passes/issue",
        headers: {
          authorization: `Bearer ${tokenWithScope}`,
        },
        payload: { guildId: "alpha", passType: "founder" },
      });

      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.equal(body.success, true);
      assert.equal(body.guildId, "alpha");
      assert.equal(body.recipient, "user_test_123");
    });
  });

  describe("2. Idempotency on Mutations", () => {
    it("returns fresh result on first call and cached result on replay with Idempotent-Replay header", async () => {
      const app = buildApp({ authSecret: TEST_SECRET });
      const token = createValidToken(["pass:issue"]);
      const idempotencyKey = "idemp_test_key_001";
      const payload = { guildId: "guild-omega", passType: "pass-1" };

      // First call: executes mutation
      const res1 = await app.inject({
        method: "POST",
        url: "/api/v2/passes/issue",
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": idempotencyKey,
        },
        payload,
      });

      assert.equal(res1.statusCode, 201);
      const body1 = res1.json();
      assert.equal(body1.success, true);
      assert.equal(res1.headers["idempotent-replay"], undefined);

      // Second call: exact same key and payload -> replayed from store
      const res2 = await app.inject({
        method: "POST",
        url: "/api/v2/passes/issue",
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": idempotencyKey,
        },
        payload,
      });

      assert.equal(res2.statusCode, 201);
      const body2 = res2.json();
      assert.deepEqual(body1, body2);
      assert.equal(res2.headers["idempotent-replay"], "true");
    });

    it("rejects idempotency key reuse with different payload with 409 IDEMPOTENCY_CONFLICT", async () => {
      const app = buildApp({ authSecret: TEST_SECRET });
      const token = createValidToken(["pass:issue"]);
      const idempotencyKey = "idemp_test_conflict_002";

      // First call
      const res1 = await app.inject({
        method: "POST",
        url: "/api/v2/passes/issue",
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": idempotencyKey,
        },
        payload: { guildId: "first-guild" },
      });
      assert.equal(res1.statusCode, 201);

      // Second call with altered payload
      const res2 = await app.inject({
        method: "POST",
        url: "/api/v2/passes/issue",
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": idempotencyKey,
        },
        payload: { guildId: "DIFFERENT-guild-payload" },
      });

      assert.equal(res2.statusCode, 409);
      const body2 = res2.json();
      assert.equal(body2.error.code, "IDEMPOTENCY_CONFLICT");
    });
  });

  describe("3. Sensitive Data Redaction & Error Sanitization", () => {
    it("masks sensitive fields in objects deterministically", () => {
      const sensitiveInput = {
        authorization: "Bearer secret-token-xyz",
        privateKey: "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        seedPhrase: "twelve secret recovery words here for stellar account",
        safeParam: "public-guild-123",
      };

      const sanitized = redact(sensitiveInput);
      assert.equal((sanitized as any).authorization, "[REDACTED]");
      assert.equal((sanitized as any).privateKey, "[REDACTED]");
      assert.equal((sanitized as any).seedPhrase, "[REDACTED]");
      assert.equal((sanitized as any).safeParam, "public-guild-123");
    });

    it("masks internal error details and stack traces from public responses", () => {
      const internalError = new Error("Database connection failed: postgres://user:password123@db.internal:5432");
      const { statusCode, payload } = sanitizeError(internalError, "trace-abc-123");

      assert.equal(statusCode, 500);
      assert.equal(payload.error.code, "INTERNAL_ERROR");
      assert.equal(payload.error.message, "An internal server error occurred");
      assert.equal(payload.error.correlationId, "trace-abc-123");
      assert.equal((payload.error as any).stack, undefined);
      assert.ok(!JSON.stringify(payload).includes("password123"));
    });
  });

  describe("4. Stellar Transaction Failure & Retry Resilience", () => {
    it("correctly classifies permanent vs transient Stellar errors", () => {
      const permanentAuth = classifyStellarError({ txResultCode: "tx_bad_auth" });
      assert.equal(permanentAuth.category, "PERMANENT");
      assert.equal(permanentAuth.isRetryable, false);

      const permanentUnderfunded = classifyStellarError({ opResultCodes: ["op_underfunded"] });
      assert.equal(permanentUnderfunded.category, "PERMANENT");
      assert.equal(permanentUnderfunded.isRetryable, false);

      const transientSeq = classifyStellarError({ txResultCode: "tx_bad_seq" });
      assert.equal(transientSeq.category, "TRANSIENT");
      assert.equal(transientSeq.isRetryable, true);

      const transient503 = classifyStellarError({ status: 503 });
      assert.equal(transient503.category, "TRANSIENT");
      assert.equal(transient503.isRetryable, true);
    });

    it("retries transient Stellar errors and succeeds if transient issue clears", async () => {
      const executor = new StellarTransactionExecutor({
        retryOptions: {
          maxAttempts: 3,
          initialDelay: 10,
          maxDelay: 50,
          jitter: { enabled: false },
        },
      });

      let callCount = 0;
      const result = await executor.submitTransaction(async () => {
        callCount++;
        if (callCount < 3) {
          throw { txResultCode: "tx_bad_seq", message: "Sequence mismatch" };
        }
        return { txHash: "0xstellar_success_hash", ledger: 5000 };
      });

      assert.equal(result.success, true);
      assert.equal(result.txHash, "0xstellar_success_hash");
      assert.equal(result.attempts, 3);
      assert.equal(callCount, 3);
    });

    it("immediately fails permanent Stellar errors without retrying", async () => {
      const executor = new StellarTransactionExecutor();
      let callCount = 0;

      await assert.rejects(async () => {
        await executor.submitTransaction(async () => {
          callCount++;
          throw { txResultCode: "tx_bad_auth", message: "Bad auth" };
        });
      }, (err: any) => {
        assert.ok(err instanceof StellarTransactionError);
        assert.equal(err.isRetryable, false);
        assert.equal(err.txResultCode, "tx_bad_auth");
        return true;
      });

      // Permanent error must not be retried!
      assert.equal(callCount, 1);
    });

    it("circuit breaker trips after consecutive transient failures, fast-failing new submissions", async () => {
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 60000,
        halfOpenProbeLimit: 1,
        isFailure: (err: unknown) => classifyStellarError(err).isRetryable,
      });

      const executor = new StellarTransactionExecutor({
        circuitBreaker,
        retryOptions: { maxAttempts: 1, initialDelay: 10 },
      });

      // Failure 1
      await assert.rejects(() =>
        executor.submitTransaction(async () => {
          throw { status: 503, message: "Horizon 503" };
        })
      );

      // Failure 2 -> triggers circuit breaker OPEN
      await assert.rejects(() =>
        executor.submitTransaction(async () => {
          throw { status: 503, message: "Horizon 503" };
        })
      );

      assert.equal(circuitBreaker.getSnapshot().state, "OPEN");

      // Submission 3: Fast-fails immediately with CIRCUIT_BREAKER_OPEN without invoking operation
      let attempted = false;
      await assert.rejects(async () => {
        await executor.submitTransaction(async () => {
          attempted = true;
          return { txHash: "never_reached" };
        });
      }, (err: any) => {
        assert.ok(err instanceof StellarTransactionError);
        assert.equal(err.txResultCode, "CIRCUIT_BREAKER_OPEN");
        return true;
      });

      assert.equal(attempted, false);
    });
  });

  describe("5. Rate Limiting", () => {
    it("allows requests within threshold and returns 429 when rate limit exceeded", async () => {
      const app = buildApp({
        authSecret: TEST_SECRET,
        enableRateLimit: true,
        rateLimitMax: 3,
        rateLimitWindowMs: 60000,
      });

      const token = createValidToken(["pass:issue"]);
      const headers = {
        authorization: `Bearer ${token}`,
      };

      // Calls 1, 2, 3 succeed
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v2/passes/issue",
          headers,
          payload: { guildId: "alpha" },
        });
        assert.equal(res.statusCode, 201);
        assert.ok(res.headers["x-ratelimit-remaining"]);
      }

      // Call 4 exceeds limit
      const res4 = await app.inject({
        method: "POST",
        url: "/api/v2/passes/issue",
        headers,
        payload: { guildId: "alpha" },
      });

      assert.equal(res4.statusCode, 429);
      const body4 = res4.json();
      assert.equal(body4.error.code, "RATE_LIMIT_EXCEEDED");
      assert.ok(res4.headers["retry-after"]);
    });
  });

  describe("6. Observability: Liveness & Readiness Signals", () => {
    it("GET /health returns 200 with service metadata", async () => {
      const app = buildApp();
      const res = await app.inject({ method: "GET", url: "/health" });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.status, "ok");
      assert.equal(body.service, "guildpass-core-api");
    });

    it("GET /ready returns 200 with memory and subsystem checks", async () => {
      const app = buildApp();
      const res = await app.inject({ method: "GET", url: "/ready" });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.status, "ready");
      assert.ok(body.checks.memory);
      assert.equal(body.checks.memory.status, "pass");
    });
  });
});
