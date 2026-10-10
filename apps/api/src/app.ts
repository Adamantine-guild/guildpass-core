import Fastify, { type FastifyInstance } from "fastify";
import { correlationPlugin } from "./plugins/correlation.js";
import { errorHandlerPlugin } from "./errors/index.js";
import { redactedLoggerPlugin } from "./observability/logging.js";
import { healthRoutes } from "./observability/health.js";
import { rateLimitPlugin } from "./plugins/rate-limit.js";
import { idempotencyPlugin } from "./plugins/idempotency.js";
import { requireScopes } from "./security/auth.js";
import {
  StellarTransactionExecutor,
  type StellarExecutorOptions,
} from "./stellar/transaction-handler.js";

export interface AppOptions {
  authSecret?: string;
  enableRateLimit?: boolean;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  stellarExecutor?: StellarTransactionExecutor;
  stellarExecutorOptions?: StellarExecutorOptions;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false, // Can be set to true in production or via env
    disableRequestLogging: true, // We use redactedLoggerPlugin for structured safe logging
  });

  // 1. Correlation & Tracing
  app.register(correlationPlugin);

  // 2. Structured Redacted Logging
  app.register(redactedLoggerPlugin);

  // 3. Centralized Sanitized Error Handling
  app.register(errorHandlerPlugin);

  // 4. Rate Limiting
  if (options.enableRateLimit !== false) {
    app.register(rateLimitPlugin, {
      limit: options.rateLimitMax ?? 100,
      windowMs: options.rateLimitWindowMs ?? 60000,
      skip: (req) => req.url === "/health" || req.url === "/ready",
    });
  }

  // 5. Idempotency Support for Mutations
  app.register(idempotencyPlugin);

  // 6. Observability: Liveness & Readiness Probes
  app.register(healthRoutes);

  // 7. Stellar Transaction Executor
  const stellarExecutor =
    options.stellarExecutor ||
    new StellarTransactionExecutor(options.stellarExecutorOptions);
  app.decorate("stellarExecutor", stellarExecutor);

  // 8. Hardened Core V2 Domain Mutation Routes
  // Route: Issue Pass (Requires "pass:issue" scope)
  app.post(
    "/api/v2/passes/issue",
    {
      preHandler: [
        requireScopes(["pass:issue"], { secret: options.authSecret }),
      ],
    },
    async (request, reply) => {
      const body = (request.body as Record<string, any>) || {};
      const guildId = body.guildId || "default-guild";
      const passType = body.passType || "standard";

      return reply.status(201).send({
        success: true,
        passId: `pass_${Date.now()}`,
        guildId,
        passType,
        recipient: request.auth?.subject,
        issuedAt: Date.now(),
      });
    }
  );

  // Route: Revoke Pass (Requires "pass:revoke" scope)
  app.post(
    "/api/v2/passes/revoke",
    {
      preHandler: [
        requireScopes(["pass:revoke"], { secret: options.authSecret }),
      ],
    },
    async (request, reply) => {
      const body = (request.body as Record<string, any>) || {};
      const passId = body.passId;

      return reply.status(200).send({
        success: true,
        passId,
        status: "revoked",
        revokedBy: request.auth?.subject,
        revokedAt: Date.now(),
      });
    }
  );

  // Route: Resilient Stellar Transaction Submission (Requires "stellar:submit" scope)
  app.post(
    "/api/v2/stellar/submit",
    {
      preHandler: [
        requireScopes(["stellar:submit"], { secret: options.authSecret }),
      ],
    },
    async (request, reply) => {
      const body = (request.body as Record<string, any>) || {};
      const mockFailures = body.mockFailures ?? 0;
      let failureCount = 0;

      const result = await stellarExecutor.submitTransaction(async () => {
        if (failureCount < mockFailures) {
          failureCount++;
          throw {
            txResultCode: "tx_bad_seq",
            message: "Mock sequence error",
          };
        }
        return {
          txHash: `0x${Buffer.from(request.correlationId).toString("hex").padEnd(64, "0").slice(0, 64)}`,
          ledger: 123456,
        };
      });

      return reply.status(200).send({
        success: true,
        txHash: result.txHash,
        ledger: result.ledger,
        attempts: result.attempts,
      });
    }
  );

  return app;
}

export default buildApp;
