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

  // Reconciliation worker
  reconciliationIntervalMs: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
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

  return result.data;
}

export const config = validateConfig();