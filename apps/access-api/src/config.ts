import { z } from 'zod';

// Define your configuration schema
const ConfigSchema = z.object({
  // Server
  port: z.coerce
    .number()
    .int()
    .positive('Port must be a positive integer')
    .default(3000),
  nodeEnv: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  // Database (REQUIRED)
  databaseUrl: z
    .string()
    .url('DATABASE_URL must be a valid URL')
    .min(1, 'DATABASE_URL is required'),

  // Logging
  logLevel: z
    .enum(['error', 'warn', 'info', 'debug'])
    .default('info'),

  // Access decision caching (disabled by default)
  accessDecisionCacheEnabled: z
    .coerce
    .boolean()
    .default(false),
  accessDecisionCacheTtlSeconds: z
    .coerce
    .number()
    .int()
    .positive('accessDecisionCacheTtlSeconds must be > 0')
    .default(30),
  // TTL for version counters; prevents unbounded key growth if never updated
  accessDecisionCacheVersionTtlSeconds: z
    .coerce
    .number()
    .int()
    .positive('accessDecisionCacheVersionTtlSeconds must be > 0')
    .default(86400),
  // Redis connection (required only when accessDecisionCacheEnabled=true)
  redisUrl: z.string().optional(),
  // Reconciliation worker
  reconciliationIntervalMs: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),

  // Outbox worker
  outboxWorkerIntervalMs: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),
  outboxWorkerBatchSize: z.coerce
    .number()
    .int()
    .positive()
    .default(50),
  // How long a worker's claim on a batch of events is honored before another
  // worker instance/shard may reclaim them (distributed-locking crash
  // recovery — see workers/outboxWorker.ts and the README's Integration
  // Event Outbox section). Must comfortably exceed the slowest realistic
  // handler call; the bundled webhook handler's default per-subscription
  // timeout is 5s.
  outboxWorkerClaimLeaseMs: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  outboxWorkerCount: z.coerce
    .number()
    .int()
    .positive()
    .default(1),
  outboxWorkerMinBatchSize: z.coerce
    .number()
    .int()
    .positive()
    .default(5),

  // Indexer worker
  indexerIntervalMs: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000),
  indexerFinalityWindow: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(12), // e.g., 12 blocks for Ethereum mainnet-like safety

  // Rate limiting
  rateLimitEnabled: z
    .string()
    .transform((v: string) => v !== 'false' && v !== '0')
    .default('true'),
  rateLimitWindowMs: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  rateLimitDefaultMax: z.coerce
    .number()
    .int()
    .positive()
    .default(100),
  rateLimitExpensiveMax: z.coerce
    .number()
    .int()
    .positive()
    .default(20),
  apiKey: z
    .string()
    .default("test-api-key"),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Validates environment configuration at startup.
 * Fails fast with clear error messages if any required vars are missing or malformed.
 */
function validateConfig(): Config {
  const envVars = {
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    logLevel: process.env.LOG_LEVEL,
    reconciliationIntervalMs: process.env.RECONCILIATION_INTERVAL_MS,
    outboxWorkerIntervalMs: process.env.OUTBOX_WORKER_INTERVAL_MS,
    outboxWorkerBatchSize: process.env.OUTBOX_WORKER_BATCH_SIZE,
    outboxWorkerClaimLeaseMs: process.env.OUTBOX_WORKER_CLAIM_LEASE_MS,
    outboxWorkerCount: process.env.OUTBOX_WORKER_COUNT,
    outboxWorkerMinBatchSize: process.env.OUTBOX_WORKER_MIN_BATCH_SIZE,
    indexerIntervalMs: process.env.INDEXER_INTERVAL_MS,
    indexerFinalityWindow: process.env.INDEXER_FINALITY_WINDOW,
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED,
    rateLimitWindowMs: process.env.RATE_LIMIT_WINDOW_MS,
    rateLimitDefaultMax: process.env.RATE_LIMIT_DEFAULT_MAX,
    rateLimitExpensiveMax: process.env.RATE_LIMIT_EXPENSIVE_MAX,
    redisUrl: process.env.REDIS_URL,
    apiKey: process.env.API_KEY || "test-api-key",
  };

  const result = ConfigSchema.safeParse(envVars);

  if (!result.success) {
    console.error(
      '\n❌ Environment configuration validation failed:\n'
    );
    result.error.errors.forEach((err) => {
      const path = err.path.join('.');
      console.error(`  ${path}: ${err.message}`);
    });
    console.error(
      '\n📖 See .env.example for all required and optional settings.\n'
    );
    process.exit(1);
  }

  // Log configuration on startup (non-sensitive values only)
  if (result.data.nodeEnv !== 'test') {
    console.log(`\n✅ Configuration loaded successfully`);
    console.log(`   NODE_ENV: ${result.data.nodeEnv}`);
    console.log(`   PORT: ${result.data.port}`);
    console.log(`   LOG_LEVEL: ${result.data.logLevel}\n`);
  }

  // If caching is enabled, ensure redisUrl is present.
  if (result.data.accessDecisionCacheEnabled && !result.data.redisUrl) {
    throw new Error('accessDecisionCacheEnabled=true requires redisUrl');
  }

  return result.data;
}

export const config = validateConfig();