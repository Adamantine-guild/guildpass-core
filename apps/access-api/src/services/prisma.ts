/**
 * prisma.ts
 *
 * Prisma client singleton with query-duration telemetry.
 *
 * Every Prisma query emits a metric on the `db_query_duration_seconds`
 * histogram labelled by { operation, model } so you can track slow queries
 * per model without logging full query text (which could contain wallet data).
 *
 * The Prisma query-event middleware is enabled via the `log` option with the
 * 'query' event, then parsed inside the $on('query') hook.
 */

import { PrismaClient } from '@prisma/client';
import { metrics } from '../observability/metrics';

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (prisma) return prisma;

  prisma = new PrismaClient({
    log: [
      // Emit structured query events we can consume below.
      { emit: 'event', level: 'query' },
      // Forward warn/error to the Fastify logger indirectly via console;
      // a full Fastify-logger bridge would require passing the logger here.
      { emit: 'stdout', level: 'warn' },
      { emit: 'stdout', level: 'error' },
    ],
  });

  // -------------------------------------------------------------------------
  // Query duration instrumentation
  //
  // Prisma's QueryEvent contains:
  //   query    – the parameterised SQL string   (we do NOT log this)
  //   params   – bound parameters               (we do NOT log this)
  //   duration – execution time in milliseconds
  //   target   – "db" | "prisma"
  //
  // We extract the model name from the query string only to derive a label;
  // no wallet data is ever written to the metric labels.
  // -------------------------------------------------------------------------
  (prisma as any).$on('query', (event: { query: string; duration: number }) => {
    // Extract the model name from patterns like:
    //   SELECT ... FROM "public"."Wallet" ...
    //   INSERT INTO "public"."Member" ...
    const modelMatch = event.query.match(/"(?:public"\.)?"([A-Z][a-zA-Z]+)"/);
    const model = modelMatch ? modelMatch[1] : 'unknown';

    // Extract the SQL verb as the operation label.
    const operationMatch = event.query.match(/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)/i);
    const operation = operationMatch
      ? operationMatch[1].toLowerCase()
      : 'other';

    metrics.dbQueryDuration.observe(
      { operation, model },
      event.duration / 1000, // ms → seconds
    );
  });

  return prisma;
}

/**
 * Gracefully disconnect Prisma. Call this during process shutdown so the
 * connection pool is released cleanly before the process exits.
 */
export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
