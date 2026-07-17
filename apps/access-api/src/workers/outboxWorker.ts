/**
 * outboxWorker.ts
 *
 * Periodically processes pending outbox events, delegating to a pluggable
 * delivery handler.  The handler is responsible for sending the event to
 * downstream systems (webhooks, message brokers, analytics pipelines, etc.).
 *
 * Design notes:
 *   - Idempotent: marks events as delivered only when the handler succeeds.
 *   - Retry with exponential backoff via markOutboxFailed.
 *   - Events that exhaust their retry budget are captured in the
 *     dead-letter store (recordDeadLetter) instead of being silently
 *     pruned once their 7-day retention window passes.
 *   - Does NOT mutate domain state — it only reads/writes the outbox table.
 *   - The default handler is a no-op that logs the event.  Replace it with
 *     your own integration (e.g. NATS, Kafka, HTTP webhook) in production —
 *     see createWebhookHandler in ../handlers/webhookHandler.ts for a
 *     production-ready HMAC-signed webhook implementation.
 */

import { PrismaClient } from "@prisma/client";
import { getPrisma } from "../services/prisma";
import {
  getPendingOutboxEvents,
  getOutboxStats,
  markOutboxDelivered,
  markOutboxFailed,
  pruneDeliveredOutboxEvents,
} from "../services/outboxService";
import { recordDeadLetter } from "../services/deadLetterService";

// ---------------------------------------------------------------------------
// Pluggable delivery handler
// ---------------------------------------------------------------------------

/**
 * An OutboxEventHandler receives a single pending outbox event and returns
 * void on success or throws on failure.
 */
export type OutboxEventHandler = (event: {
  id: string;
  eventType: string;
  entityId: string | null;
  entityType: string | null;
  communityId: string | null;
  payload: any;
  createdAt: Date;
}) => Promise<void>;

/**
 * Default no-op handler.  Replace with your own integration logic.
 */
const defaultHandler: OutboxEventHandler = async (event) => {
  // eslint-disable-next-line no-console
  console.log(
    `[outboxWorker] Delivered event ${event.id} (${event.eventType})` +
      ` community=${event.communityId ?? "N/A"}`,
  );
};

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface OutboxWorkerResult {
  processed: number;
  delivered: number;
  failed: number;
  errors: number;
}

export interface OutboxWorker {
  start(): void;
  stop(): void;
  runOnce(): Promise<OutboxWorkerResult>;
}

/**
 * Process one batch of pending outbox events.
 */
export async function processOutboxBatch(
  db: PrismaClient,
  handler: OutboxEventHandler,
  batchSize: number = 50,
): Promise<OutboxWorkerResult> {
  const pending = await getPendingOutboxEvents(db as any, batchSize);

  let delivered = 0;
  let failed = 0;
  let errors = 0;

  for (const event of pending) {
    try {
      await handler({
        id: event.id,
        eventType: event.eventType,
        entityId: event.entityId,
        entityType: event.entityType,
        communityId: event.communityId,
        payload: event.payload,
        createdAt: event.createdAt,
      });

      await markOutboxDelivered(db as any, event.id);
      delivered++;
    } catch (err: any) {
      const errorMessage =
        err?.message ?? "Unknown delivery error";
      // eslint-disable-next-line no-console
      console.error(
        `[outboxWorker] Failed to deliver event ${event.id}:`,
        errorMessage,
      );

      try {
        const { permanentlyFailed, retryCount } = await markOutboxFailed(db as any, event.id, errorMessage);
        failed++;

        if (permanentlyFailed) {
          try {
            await recordDeadLetter(db as any, {
              id: event.id,
              eventType: event.eventType,
              entityId: event.entityId,
              entityType: event.entityType,
              communityId: event.communityId,
              payload: event.payload,
              lastError: errorMessage,
              retryCount,
            });
          } catch (deadLetterErr) {
            // eslint-disable-next-line no-console
            console.error(
              `[outboxWorker] Failed to dead-letter event ${event.id}:`,
              deadLetterErr,
            );
            errors++;
          }
        }
      } catch (updateErr) {
        // eslint-disable-next-line no-console
        console.error(
          `[outboxWorker] Failed to mark event ${event.id} as failed:`,
          updateErr,
        );
        errors++;
      }
    }
  }

  return { processed: pending.length, delivered, failed, errors };
}

/**
 * Create a scheduled outbox worker.
 *
 * @param intervalMs   How often to poll for pending events.
 * @param handler      Optional custom delivery handler.
 * @param db           Optional Prisma client (injected for testing).
 * @param batchSize    Max events to process per pass.
 */
export function createOutboxWorker(
  intervalMs: number,
  handler?: OutboxEventHandler,
  db?: PrismaClient,
  batchSize?: number,
): OutboxWorker {
  const prisma = db ?? getPrisma();
  const eventHandler = handler ?? defaultHandler;
  const batch = batchSize ?? 50;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function run() {
    try {
      const result = await processOutboxBatch(prisma, eventHandler, batch);
      if (result.processed > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[outboxWorker] Batch complete: processed=${result.processed}` +
            ` delivered=${result.delivered} failed=${result.failed}` +
            ` errors=${result.errors}`,
        );
      }

      // Periodically prune delivered events older than 7 days.
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        await pruneDeliveredOutboxEvents(prisma as any, sevenDaysAgo);
      } catch {
        // Pruning is best-effort; never crash the worker.
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[outboxWorker] Unhandled error in pass:", err);
    }
  }

  return {
    start() {
      if (timer) return;
      // Run immediately on start, then at the configured interval.
      run();
      timer = setInterval(run, intervalMs);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    async runOnce(): Promise<OutboxWorkerResult> {
      return processOutboxBatch(prisma, eventHandler, batch);
    },
  };
}
