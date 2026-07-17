import type { PrismaClient } from "@prisma/client";
import type {
  OutboxEventType,
  OutboxEventDto,
  OutboxDispatchResult,
  OutboxEventStatus,
} from "@guildpass/shared-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OutboxEventClient = {
  create: (args: { data: any }) => Promise<any>;
  update: (args: { where: any; data: any }) => Promise<any>;
  findMany: (args?: any) => Promise<any[]>;
  count: (args?: any) => Promise<number>;
};

type PrismaLikeClient = {
  outboxEvent: OutboxEventClient;
};

export type OutboxEventInput = {
  eventType: OutboxEventType;
  entityId?: string | null;
  entityType?: string | null;
  communityId?: string | null;
  payload?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Durable outbox service for integration events.
 *
 * Events are written inside the same Prisma transaction as the domain mutation
 * so that no event is ever lost on request failure or process restart.
 *
 * Design notes:
 *   - Never throws from logOutboxEventTx — a failed event write is a critical
 *     transactional failure that should roll back the entire mutation.
 *   - The worker marks events as delivered or failed asynchronously.
 *   - Retries use exponential backoff (nextRetryAt = now + 2^retryCount * seconds).
 */

const DEFAULT_MAX_RETRIES = 5;
const BASE_RETRY_DELAY_SECONDS = 10;

function computeNextRetryAt(retryCount: number): Date {
  const delaySeconds = BASE_RETRY_DELAY_SECONDS * Math.pow(2, retryCount);
  return new Date(Date.now() + delaySeconds * 1000);
}

/**
 * Persist an outbox event to the DB using the default Prisma client
 * or a transaction-scoped client.
 */
export async function logOutboxEvent(
  db: PrismaLikeClient | PrismaClient,
  event: OutboxEventInput,
): Promise<OutboxDispatchResult> {
  return logOutboxEventTx(db as PrismaLikeClient, event);
}

/**
 * Transaction-aware outbox event creation.
 *
 * Call this inside a Prisma `$transaction` callback alongside your domain
 * mutation to guarantee atomicity between the state change and the event.
 */
export async function logOutboxEventTx(
  db: PrismaLikeClient,
  event: OutboxEventInput,
): Promise<OutboxDispatchResult> {
  const created = await db.outboxEvent.create({
    data: {
      eventType: event.eventType,
      entityId: event.entityId ?? null,
      entityType: event.entityType ?? null,
      communityId: event.communityId ?? null,
      payload: event.payload ?? {},
      status: "pending",
      retryCount: 0,
      maxRetries: DEFAULT_MAX_RETRIES,
      nextRetryAt: new Date(), // eligible immediately
    },
  });

  return { eventId: created.id, status: "pending" };
}

// ---------------------------------------------------------------------------
// Delivery helpers (used by the worker)
// ---------------------------------------------------------------------------

/**
 * Mark an outbox event as successfully delivered.
 */
export async function markOutboxDelivered(
  db: PrismaLikeClient,
  eventId: string,
): Promise<void> {
  await db.outboxEvent.update({
    where: { id: eventId },
    data: {
      status: "delivered",
      deliveredAt: new Date(),
      nextRetryAt: null,
    },
  });
}

export interface MarkOutboxFailedResult {
  /** True once retries are exhausted and the event is now permanently failed. */
  permanentlyFailed: boolean;
  /** The retryCount value just written, so callers don't need to re-derive it. */
  retryCount: number;
}

/**
 * Mark an outbox event as failed.
 * If retries remain, increment the count and schedule the next retry.
 * Otherwise set to permanent failure and report it so the caller can
 * route the event into the dead-letter store.
 */
export async function markOutboxFailed(
  db: PrismaLikeClient,
  eventId: string,
  errorMessage: string,
): Promise<MarkOutboxFailedResult> {
  const existing = await db.outboxEvent.findMany({
    where: { id: eventId },
  });

  if (!existing || existing.length === 0) return { permanentlyFailed: false, retryCount: 0 };
  const event = existing[0];

  const nextCount = (event.retryCount ?? 0) + 1;

  if (nextCount < (event.maxRetries ?? DEFAULT_MAX_RETRIES)) {
    await db.outboxEvent.update({
      where: { id: eventId },
      data: {
        retryCount: nextCount,
        lastError: errorMessage,
        nextRetryAt: computeNextRetryAt(nextCount),
      },
    });
    return { permanentlyFailed: false, retryCount: nextCount };
  }

  await db.outboxEvent.update({
    where: { id: eventId },
    data: {
      status: "failed",
      retryCount: nextCount,
      lastError: errorMessage,
      nextRetryAt: null,
    },
  });
  return { permanentlyFailed: true, retryCount: nextCount };
}

// ---------------------------------------------------------------------------
// Query helpers (used by the worker)
// ---------------------------------------------------------------------------

/**
 * Fetch pending (or retryable) outbox events that are due for processing,
 * ordered by creation time (oldest first).
 */
export async function getPendingOutboxEvents(
  db: PrismaLikeClient,
  limit: number = 50,
): Promise<any[]> {
  const now = new Date();
  return db.outboxEvent.findMany({
    where: {
      status: "pending",
      nextRetryAt: { lte: now },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/**
 * Count events by status for observability.
 */
export async function getOutboxStats(db: PrismaLikeClient): Promise<{
  pending: number;
  delivered: number;
  failed: number;
}> {
  const [pending, delivered, failed] = await Promise.all([
    db.outboxEvent.count({ where: { status: "pending" } }),
    db.outboxEvent.count({ where: { status: "delivered" } }),
    db.outboxEvent.count({ where: { status: "failed" } }),
  ]);

  return { pending, delivered, failed };
}

/**
 * Prune delivered events older than the given date.
 * Call periodically to avoid unbounded table growth.
 */
export async function pruneDeliveredOutboxEvents(
  db: PrismaLikeClient,
  olderThan: Date,
): Promise<number> {
  const result = await (db as any).outboxEvent.deleteMany({
    where: {
      status: "delivered",
      deliveredAt: { lt: olderThan },
    },
  });
  return result?.count ?? 0;
}
