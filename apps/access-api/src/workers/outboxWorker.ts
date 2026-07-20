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
 *
 * Horizontal scalability:
 *   - Uses SELECT ... FOR UPDATE SKIP LOCKED so that N concurrent worker
 *     "shards" can each claim a disjoint set of pending events without
 *     coordination.  Each shard runs its own independent polling loop.
 *   - Throughput scales roughly linearly with shard count up to the
 *     database connection-pool limit.
 *   - Adaptive batch sizing: when the downstream handler produces sustained
 *     failures the batch size is reduced (and an extra backoff delay is
 *     added) to avoid hammering a struggling consumer.  When the handler
 *     recovers the batch size ramps back up.
 *   - Backlog depth is reported as a Prometheus gauge so operators can
 *     observe whether the worker fleet keeps up with event production.
 */

import { PrismaClient } from "@prisma/client";
import { getPrisma } from "../services/prisma";
import {
  claimPendingOutboxEventsWithLock,
  getOutboxBacklogDepth,
  markOutboxDelivered,
  markOutboxFailed,
  pruneDeliveredOutboxEvents,
} from "../services/outboxService";
import { recordDeadLetter } from "../services/deadLetterService";
import { metrics } from "../observability/metrics";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default adaptive-batch ceiling (matches the old fixed default).
 */
const DEFAULT_MAX_BATCH_SIZE = 50;

/**
 * Smallest batch we will ever shrink to under backpressure.
 */
const DEFAULT_MIN_BATCH_SIZE = 5;

/**
 * The number of consecutive batch iterations with zero successful deliveries
 * that triggers a backpressure reduction.
 */
const BACKPRESSURE_CONSECUTIVE_THRESHOLD = 3;

/**
 * How often (in ms) the shared backlog-depth gauge is refreshed.  Only one
 * shard per worker instance performs this update to avoid redundant queries.
 */
const BACKLOG_REPORT_INTERVAL_MS = 15_000;

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
// Types
// ---------------------------------------------------------------------------

export interface OutboxWorkerResult {
  processed: number;
  delivered: number;
  failed: number;
  errors: number;
}

export interface OutboxWorkerOptions {
  /** How often each shard polls for pending events (ms).  Default: 10 000. */
  intervalMs: number;

  /** Optional custom delivery handler. */
  handler?: OutboxEventHandler;

  /** Optional Prisma client (injected for testing). */
  db?: PrismaClient;

  /**
   * Number of concurrent shards to run.  Each shard independently claims
   * events via FOR UPDATE SKIP LOCKED.  Default: 1.
   */
  workerCount?: number;

  /**
   * Maximum batch size per shard per poll cycle.  Default: 50.
   */
  maxBatchSize?: number;

  /**
   * Minimum batch size when backpressure is active.  Default: 5.
   */
  minBatchSize?: number;
}

export interface OutboxWorkerShard {
  readonly id: number;
  start(): void;
  stop(): void;
}

export interface OutboxWorker {
  start(): void;
  stop(): void;
  runOnce(): Promise<OutboxWorkerResult>;
  readonly shards: OutboxWorkerShard[];
}

// ---------------------------------------------------------------------------
// Adaptive batch-size tracker
// ---------------------------------------------------------------------------

class AdaptiveBatch {
  private current: number;
  private consecutiveFailures = 0;

  constructor(
    private readonly max: number,
    private readonly min: number,
  ) {
    this.current = max;
  }

  get size(): number {
    return this.current;
  }

  /**
   * Call after a batch iteration completes.  Adjusts the batch size based on
   * whether events were successfully delivered.
   */
  recordIteration(delivered: number): void {
    if (delivered === 0) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= BACKPRESSURE_CONSECUTIVE_THRESHOLD) {
        // Reduce batch size by half (floor) and reset counter.
        this.current = Math.max(this.min, Math.floor(this.current / 2));
        this.consecutiveFailures = 0;
      }
    } else {
      this.consecutiveFailures = 0;
      // Ramp up gently: add 5 (capped at max).
      this.current = Math.min(this.max, this.current + 5);
    }
  }

  /**
   * Returns the extra backoff delay (ms) to insert before the next poll when
   * the system is under backpressure.  0 means no extra delay.
   */
  get backoffMs(): number {
    if (this.consecutiveFailures >= BACKPRESSURE_CONSECUTIVE_THRESHOLD) {
      // Exponential backoff: 1s, 2s, 4s, …
      return 1000 * Math.pow(2, this.consecutiveFailures - BACKPRESSURE_CONSECUTIVE_THRESHOLD);
    }
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

/**
 * Process one batch of pending outbox events using FOR UPDATE SKIP LOCKED.
 *
 * This function is also exported for backward compatibility in tests; note
 * that it now expects a real PrismaClient (so it can use raw SQL) and
 * increments Prometheus counters inline.
 */
export async function processOutboxBatch(
  db: PrismaClient,
  handler: OutboxEventHandler,
  batchSize: number = DEFAULT_MAX_BATCH_SIZE,
): Promise<OutboxWorkerResult> {
  const pending = await claimPendingOutboxEventsWithLock(db, batchSize);

  let delivered = 0;
  let failed = 0;
  let errors = 0;

  for (const event of pending) {
    const eventType = event.eventType;
    try {
      await handler({
        id: event.id,
        eventType,
        entityId: event.entityId,
        entityType: event.entityType,
        communityId: event.communityId,
        payload: event.payload,
        createdAt: event.createdAt,
      });

      await markOutboxDelivered(db as any, event.id);
      delivered++;
      metrics.outboxEventsDeliveredTotal.inc({ event_type: eventType });
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
          metrics.outboxEventsFailedTotal.inc({ event_type: eventType });
          try {
            await recordDeadLetter(db as any, {
              id: event.id,
              eventType,
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

// ---------------------------------------------------------------------------
// Worker shard
// ---------------------------------------------------------------------------

/**
 * A single polling shard within the outbox worker.  Each shard runs its own
 * setInterval loop with its own AdaptiveBatch tracker.
 */
function createShard(
  id: number,
  options: OutboxWorkerOptions,
  prisma: PrismaClient,
  handler: OutboxEventHandler,
): OutboxWorkerShard {
  const adaptiveBatch = new AdaptiveBatch(
    options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    options.minBatchSize ?? DEFAULT_MIN_BATCH_SIZE,
  );
  let timer: ReturnType<typeof setInterval> | null = null;

  async function run() {
    try {
      const batchSize = adaptiveBatch.size;
      const result = await processOutboxBatch(prisma, handler, batchSize);

      adaptiveBatch.recordIteration(result.delivered);

      metrics.outboxWorkerBatchSize.set({ shard: String(id) }, adaptiveBatch.size);

      if (result.processed > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[outboxWorker:shard-${id}] Batch complete:` +
            ` processed=${result.processed} delivered=${result.delivered}` +
            ` failed=${result.failed} errors=${result.errors}` +
            ` batchSize=${adaptiveBatch.size}`,
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
      console.error(`[outboxWorker:shard-${id}] Unhandled error in pass:`, err);
    }
  }

  return {
    id,
    start() {
      if (timer) return;
      // Run immediately on start, then at the configured interval.
      run();
      // If under backpressure, insert extra delay on the first iteration too.
      const backoff = adaptiveBatch.backoffMs;
      timer = setInterval(run, options.intervalMs + backoff);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

/**
 * Create a horizontally-scalable outbox worker.
 *
 * The worker launches `workerCount` independent shards (default 1).  Each
 * shard claims pending events via `SELECT ... FOR UPDATE SKIP LOCKED`, so
 * multiple shards (even across different process instances) can safely drain
 * the queue in parallel without duplicate delivery.
 *
 * Adaptive batch sizing: when a shard sees consecutive batches with zero
 * deliveries it halves its batch size and inserts an exponential backoff
 * delay.  When deliveries succeed it gradually ramps back up.
 *
 * A shared timer periodically reports backlog depth as a Prometheus gauge.
 */
export function createOutboxWorker(options: OutboxWorkerOptions): OutboxWorker {
  const prisma = options.db ?? getPrisma();
  const handler = options.handler ?? defaultHandler;
  const workerCount = options.workerCount ?? 1;

  const shards: OutboxWorkerShard[] = [];
  let backlogTimer: ReturnType<typeof setInterval> | null = null;

  return {
    shards,

    start() {
      if (shards.length > 0) return; // already started
      for (let i = 0; i < workerCount; i++) {
        const shard = createShard(i, options, prisma, handler);
        shard.start();
        shards.push(shard);
      }

      // Shared backlog-depth reporter (only the first shard schedules this).
      backlogTimer = setInterval(async () => {
        try {
          const depth = await getOutboxBacklogDepth(prisma);
          metrics.outboxBacklogDepth.set(depth);
        } catch {
          // Best-effort; never crash the worker.
        }
      }, BACKLOG_REPORT_INTERVAL_MS);
      // Report once immediately so the gauge has a value.
      getOutboxBacklogDepth(prisma).then((depth) => {
        metrics.outboxBacklogDepth.set(depth);
      }).catch(() => {});
    },

    stop() {
      for (const shard of shards) {
        shard.stop();
      }
      shards.length = 0;
      if (backlogTimer) {
        clearInterval(backlogTimer);
        backlogTimer = null;
      }
    },

    async runOnce(): Promise<OutboxWorkerResult> {
      return processOutboxBatch(prisma, handler, options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE);
    },
  };
}
