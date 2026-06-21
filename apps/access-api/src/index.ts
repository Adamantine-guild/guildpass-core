/**
 * index.ts
 *
 * Process entry point. Builds the Fastify app, binds the port, and wires up
 * graceful shutdown (SIGTERM / SIGINT) so in-flight requests and the Prisma
 * connection pool are cleaned up before the process exits.
 */

import { buildApp } from './app';
import { disconnectPrisma } from './services/prisma';

async function main() {
  const app = await buildApp();
  const port = parseInt(process.env.PORT || '3000', 10);

  await app.listen({ port, host: '0.0.0.0' });

  // ------------------------------------------------------------------------
  // Graceful shutdown
  // ------------------------------------------------------------------------
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Received shutdown signal, closing server…');
    try {
      await app.close();
      await disconnectPrisma();
      app.log.info('Server and database connections closed cleanly.');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
