/**
 * deadLetterService.ts
 *
 * Durable dead-letter store for outbox events that exhausted the outbox's
 * own max-retry budget (OutboxEvent.status transitions to "failed"). Rather
 * than being silently pruned 7 days later like any other "failed" event,
 * these are captured here so an operator can inspect them and manually
 * re-trigger delivery via the admin routes.
 */

import type { PrismaClient } from "@prisma/client";
import type { DeadLetterStatus } from "@guildpass/shared-types";

type DeadLetterEventClient = {
  create: (args: { data: any }) => Promise<any>;
  findMany: (args?: any) => Promise<any[]>;
  findUnique: (args: any) => Promise<any>;
  update: (args: { where: any; data: any }) => Promise<any>;
  count: (args?: any) => Promise<number>;
};

type OutboxEventClient = {
  create: (args: { data: any }) => Promise<any>;
};

type PrismaLikeClient = {
  deadLetterEvent: DeadLetterEventClient;
  outboxEvent: OutboxEventClient;
};

export interface DeadLetterCandidate {
  id: string;
  eventType: string;
  entityId: string | null;
  entityType: string | null;
  communityId: string | null;
  payload: unknown;
  lastError: string | null;
  retryCount: number;
}

/**
 * Record a permanently-failed outbox event in the dead-letter store.
 * Called by the outbox worker immediately after markOutboxFailed reports
 * that an event has exhausted its retries.
 */
export async function recordDeadLetter(
  db: PrismaLikeClient | PrismaClient,
  event: DeadLetterCandidate,
): Promise<{ id: string }> {
  const created = await (db as PrismaLikeClient).deadLetterEvent.create({
    data: {
      originalEventId: event.id,
      eventType: event.eventType,
      entityId: event.entityId,
      entityType: event.entityType,
      communityId: event.communityId,
      payload: event.payload ?? {},
      failureReason: event.lastError ?? "Unknown delivery error",
      retryCount: event.retryCount,
      status: "pending",
    },
  });

  return { id: created.id };
}

export interface ListDeadLetterFilter {
  communityId?: string;
  status?: DeadLetterStatus;
}

/**
 * List dead-lettered events, most recent first, optionally filtered by
 * community and/or status. Used by the admin inspection route.
 */
export async function listDeadLetterEvents(
  db: PrismaLikeClient | PrismaClient,
  filter: ListDeadLetterFilter = {},
  limit: number = 50,
): Promise<any[]> {
  return (db as PrismaLikeClient).deadLetterEvent.findMany({
    where: {
      ...(filter.communityId ? { communityId: filter.communityId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export class DeadLetterNotFoundError extends Error {
  constructor(id: string) {
    super(`Dead-letter event ${id} not found`);
    this.name = "DeadLetterNotFoundError";
  }
}

export class DeadLetterAlreadyResolvedError extends Error {
  constructor(id: string) {
    super(`Dead-letter event ${id} has already been retried or resolved`);
    this.name = "DeadLetterAlreadyResolvedError";
  }
}

/**
 * Manually retry a dead-lettered event: re-enqueues a fresh pending
 * OutboxEvent from the dead-letter's payload (so it goes through the
 * normal delivery + retry path again) and marks the dead-letter row as
 * "retried" so it isn't retried twice.
 */
export async function retryDeadLetterEvent(
  db: PrismaLikeClient | PrismaClient,
  id: string,
): Promise<{ newEventId: string }> {
  const client = db as PrismaLikeClient;
  const deadLetter = await client.deadLetterEvent.findUnique({ where: { id } });

  if (!deadLetter) {
    throw new DeadLetterNotFoundError(id);
  }
  if (deadLetter.status !== "pending") {
    throw new DeadLetterAlreadyResolvedError(id);
  }

  const newEvent = await client.outboxEvent.create({
    data: {
      eventType: deadLetter.eventType,
      entityId: deadLetter.entityId,
      entityType: deadLetter.entityType,
      communityId: deadLetter.communityId,
      payload: deadLetter.payload ?? {},
      status: "pending",
      retryCount: 0,
      nextRetryAt: new Date(),
    },
  });

  await client.deadLetterEvent.update({
    where: { id },
    data: { status: "retried", resolvedAt: new Date() },
  });

  return { newEventId: newEvent.id };
}
