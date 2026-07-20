import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { OutboxEventType, OutboxDispatchResult } from "@guildpass/shared-types";

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
  // Tagged-template raw query, used only by claimPendingOutboxEvents for the
  // `SELECT ... FOR UPDATE SKIP LOCKED` claim that Prisma's query builder
  // cannot express.
  $queryRaw: <T = any>(strings: TemplateStringsArray, ...values: any[]) => Promise<T>;
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
 *
 * Clears the claim lease (claimedAt/claimedBy/claimExpiresAt) alongside the
 * status change. Not strictly required for correctness here — a delivered
 * row never matches claimPendingOutboxEvents' `status = 'pending'`
 * predicate regardless — but keeps the claim columns from holding stale
 * data that would be confusing to read during an incident.
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
      claimedAt: null,
      claimedBy: null,
      claimExpiresAt: null,
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
 *
 * The retry branch clears the claim lease (claimedAt/claimedBy/
 * claimExpiresAt) alongside scheduling nextRetryAt. This is load-bearing,
 * not cosmetic: the row stays status='pending' for a retry, and
 * claimPendingOutboxEvents' predicate treats a still-future claimExpiresAt
 * as "currently claimed." Without clearing it here, a retried event would
 * sit unclaimable until the *original* claim's lease happened to elapse,
 * silently delaying redelivery well past its computed nextRetryAt.
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
        claimedAt: null,
        claimedBy: null,
        claimExpiresAt: null,
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
      claimedAt: null,
      claimedBy: null,
      claimExpiresAt: null,
    },
  });
  return { permanentlyFailed: true, retryCount: nextCount };
}

// ---------------------------------------------------------------------------
// Query helpers (used by the worker)
// ---------------------------------------------------------------------------

/** Default claim lease if the caller doesn't supply one (see config.ts's
 *  outboxWorkerClaimLeaseMs for the value actually used in production). */
const DEFAULT_CLAIM_LEASE_MS = 60_000;

export interface ClaimedOutboxEvent {
  id: string;
  eventType: string;
  entityId: string | null;
  entityType: string | null;
  communityId: string | null;
  payload: unknown;
  createdAt: Date;
}

/**
 * Atomically claim up to `limit` pending, due outbox events for this worker
 * instance/shard via `SELECT ... FOR UPDATE SKIP LOCKED`, so that two
 * workers polling the same table concurrently never claim the same row.
 * This is the safe claim primitive — see claimPendingOutboxEventsWithLock
 * below for why that alternative is not.
 *
 * This is a single `UPDATE ... RETURNING` statement — the claim lease
 * (claimExpiresAt) is stamped in the same statement that locks the rows via
 * the SKIP LOCKED subquery, so there is no separate "claim, then commit"
 * step and no window where another worker could see a claimed row as free.
 *
 * Crash recovery is automatic and needs no reaper process: if this worker
 * dies before calling markOutboxDelivered/markOutboxFailed, the row stays
 * status='pending' with a claimExpiresAt that will elapse, and the WHERE
 * clause below (`claimExpiresAt IS NULL OR claimExpiresAt < now()`) makes it
 * claimable again by any worker's next poll.
 *
 * Trade-off, by design: SKIP LOCKED lets concurrent workers grab
 * non-adjacent rows in the same instant, so cross-worker delivery order is
 * no longer strictly createdAt-ascending the way a single worker's is
 * today. See the README's "Integration Event Outbox" section.
 *
 * Note on ordering and `RETURNING`: Postgres does not guarantee that an
 * `UPDATE ... WHERE id IN (subquery) RETURNING ...` returns rows in the
 * subquery's `ORDER BY` — that ORDER BY only controls *which* rows the
 * LIMIT selects, not the order the outer UPDATE reports them back in. So
 * this function re-sorts the returned rows by (createdAt, id) itself,
 * which is what actually preserves the single-worker, no-contention
 * ordering guarantee the old Prisma `findMany({ orderBy })` gave for free.
 */
export async function claimPendingOutboxEvents(
  db: PrismaLikeClient,
  limit: number,
  workerId: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): Promise<ClaimedOutboxEvent[]> {
  const claimed = await db.$queryRaw<ClaimedOutboxEvent[]>`
    UPDATE "OutboxEvent"
    SET "claimedAt" = now(),
        "claimedBy" = ${workerId},
        "claimExpiresAt" = now() + (${leaseMs}::text || ' milliseconds')::interval
    WHERE id IN (
      SELECT id FROM "OutboxEvent"
      WHERE status = 'pending'::"OutboxEventStatus"
        AND "nextRetryAt" <= now()
        AND ("claimExpiresAt" IS NULL OR "claimExpiresAt" < now())
      ORDER BY "createdAt" ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "eventType", "entityId", "entityType", "communityId", "payload", "createdAt";
  `;

  return claimed.sort((a, b) => {
    const byCreatedAt = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id);
  });
}

/**
 * @deprecated Do not wire this into any worker path — it does not actually
 * prevent duplicate delivery. Kept for history/reference only; use
 * claimPendingOutboxEvents above instead.
 *
 * This runs `SELECT ... FOR UPDATE SKIP LOCKED` as a single standalone
 * `$queryRaw` call, not wrapped in an explicit transaction. Prisma commits a
 * non-transactional raw query as soon as it returns, which releases the
 * `FOR UPDATE` row lock immediately — before the caller has done anything
 * with the claimed rows. Nothing here writes a durable "claimed" marker
 * (no claimedAt/claimedBy/status change), so the moment this function
 * returns, the rows it "claimed" are indistinguishable from unclaimed ones:
 * status is still 'pending' and no lock is held. A second caller polling
 * while the first is still running its handler against those rows (e.g.
 * during a webhook HTTP call) will claim and deliver the same rows again.
 *
 * Verified against a real Postgres instance: two sequential, independent
 * `SELECT ... FOR UPDATE SKIP LOCKED` calls with no update in between both
 * returned the identical row set. claimPendingOutboxEvents avoids this by
 * stamping the claim lease in the same UPDATE statement that takes the
 * lock, so the claim is a durable row value rather than a lock that has to
 * outlive a single query.
 *
 * @returns Array of claimed outbox event rows (with all Prisma column names).
 */
export async function claimPendingOutboxEventsWithLock(
  db: PrismaClient,
  limit: number = 50,
): Promise<any[]> {
  const now = new Date();
  const rows: any[] = await db.$queryRaw(
    Prisma.sql`
      SELECT *
      FROM "OutboxEvent"
      WHERE status = 'pending' AND "nextRetryAt" <= ${now}
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `,
  );
  return rows;
}

/**
 * Count the number of pending outbox events that are currently due for
 * processing (status = 'pending' AND nextRetryAt <= now).  Exposed as a
 * Prometheus gauge so operators can observe whether the worker fleet is
 * keeping up with the event production rate.
 */
export async function getOutboxBacklogDepth(
  db: PrismaClient,
): Promise<number> {
  const now = new Date();
  const result: Array<{ count: bigint }> = await db.$queryRaw(
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "OutboxEvent"
      WHERE status = 'pending' AND "nextRetryAt" <= ${now}
    `,
  );
  return Number(result[0]?.count ?? 0);
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
