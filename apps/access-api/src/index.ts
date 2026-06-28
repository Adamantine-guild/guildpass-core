/**
 * index.ts
 * Process entry point. Builds the Fastify app, binds the port, and wires up
 * graceful shutdown (SIGTERM / SIGINT) so in-flight requests and the Prisma
 * connection pool are cleaned up before the process exits.
 */

import { buildApp } from './app';
import { config } from './config';
import { disconnectPrisma } from './services/prisma';
import { createReconciliationWorker } from './workers/reconciliationWorker';

async function main() {
  const app = await buildApp();

  const worker = createReconciliationWorker(config.reconciliationIntervalMs);
  worker.start();

  await app.listen({ port: config.port, host: '0.0.0.0' });

  console.log(
    `🚀 Server running on http://0.0.0.0:${config.port} (${config.nodeEnv})`
  );

  // -----------------------------------------------------------------------
  // Graceful shutdown
  // -----------------------------------------------------------------------
  const shutdown = async (signal: string) => {
    console.log(
      `\n⏹️  Received ${signal} shutdown signal, closing server...`
    );
    try {
      worker.stop();
      await disconnectPrisma();
      console.log('✅ Server and database connections closed cleanly.');
      process.exit(0);
    } catch (err) {
      console.error(`\n❌ Error during graceful shutdown:\n`, err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`\n❌ Failed to start server:\n`, err);
  process.exit(1);
});
