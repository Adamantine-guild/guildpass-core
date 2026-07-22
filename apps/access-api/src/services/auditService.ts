import { PrismaClient, Prisma, EventType } from "@prisma/client";
import { writeChainedAuditEvent } from "./auditChainHasher";

const prisma = new PrismaClient();

// Transaction-scoped Prisma clients expose an auditEvent model.
// We keep this intentionally loose so callers can pass Prisma's transaction client.
type AuditEventClient = {
  create: (args: any) => any;
};

type OutboxEventClient = {
  create: (args: { data: any }) => any;
};

type PrismaLikeClient = {
  auditEvent: AuditEventClient;
  outboxEvent?: OutboxEventClient;
};


export type AuditEventInput = {

  eventType:
    | "ACCESS_CHECK"
    | "MEMBERSHIP_CREATED"
    | "MEMBERSHIP_UPDATED"
    | "MEMBERSHIP_DELETED"
    | "POLICY_EVALUATION"
    | "MEMBERSHIP_RECONCILED"
    | "OTHER";
  walletId?: string | null;
  communityId?: string | null;
  resource?: string | null;
  policyRule?: string | null;
  decision?: string | null;
  reasonCode?: string | null;
  beforeState?: any | null;
  afterState?: any | null;
  correlationId?: string | null;
  chainId?: number | null;
  txHash?: string | null;
  blockNumber?: number | null;
  logIndex?: number | null;
  membershipStateVersion?: string | null;
  roleStateVersion?: string | null;
};

/**
 * Persist an audit event to the DB with hash-chain integrity.
 *
 * Each record includes a keccak256 hash of its own content chained to the
 * previous record's hash, forming a tamper-evident, append-only log.
 * Concurrent writes are serialized via a PostgreSQL advisory lock.
 */
export async function logEvent(event: AuditEventInput) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    return writeChainedAuditEvent(tx, event);
  });
}

/**
 * Transaction-aware audit event creation with hash-chain integrity.
 *
 * Must be called inside a Prisma `$transaction` callback so the PostgreSQL
 * advisory lock that serializes the chain is held for the full read-then-write.
 *
 * Also emits a durable outbox event for ACCESS_CHECK decisions so downstream
 * integrations (dashboards, bots, webhooks, analytics) can consume them
 * reliably.
 */
export async function logEventTx(
  tx: Prisma.TransactionClient,
  event: AuditEventInput,
) {
  const auditResult = await writeChainedAuditEvent(tx, event);

  // Also emit a durable outbox event for ACCESS_CHECK decisions so
  // downstream integrations can consume them reliably.
  if (tx.outboxEvent && event.eventType === "ACCESS_CHECK") {
    await tx.outboxEvent.create({
      data: {
        eventType: "ACCESS_DECISION",
        entityId: event.walletId ?? null,
        entityType: "AccessDecision",
        communityId: event.communityId ?? null,
        correlationId: event.correlationId ?? null,
        chainId: event.chainId ?? null,
        txHash: event.txHash ?? null,
        blockNumber: event.blockNumber ?? null,
        logIndex: event.logIndex ?? null,
        payload: {
          walletId: event.walletId ?? null,
          resource: event.resource ?? null,
          policyRule: event.policyRule ?? null,
          decision: event.decision ?? null,
          reasonCode: event.reasonCode ?? null,
          membershipStateVersion: event.membershipStateVersion ?? null,
          roleStateVersion: event.roleStateVersion ?? null,
        },
        status: "pending",
        retryCount: 0,
        maxRetries: 5,
        nextRetryAt: new Date(),
      },
    });
  }

  return auditResult;
}


/**
 * Get audit events for a communityId + walletId, newest first. Pagination optional.
 */
export async function getEventsByCommunityAndWallet(
  communityId: string,
  walletId: string,
  limit = 50,
  cursor?: string,
) {
  const where: any = { communityId, walletId };

  const args: any = {
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  };
  if (cursor) {
    args.skip = 1;
    args.cursor = { id: cursor };
  }
  return prisma.auditEvent.findMany(args);
}

/**
 * Get audit events for a communityId, newest first. Pagination optional.
 */
export async function getEventsByCommunity(
  communityId: string,
  limit = 50,
  cursor?: string,
) {
  const where: any = { communityId };
  const args: any = {
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  };
  if (cursor) {
    args.skip = 1;
    args.cursor = { id: cursor };
  }
  return prisma.auditEvent.findMany(args);
}

export interface QueryAuditEventsInput {
  communityId: string;
  actorWallet?: string;
  eventType?: EventType | string;
  resource?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

export interface PaginatedAuditEventsResult {
  events: any[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Filterable, paginated audit_events query service.
 * Supports filtering by communityId, actorWallet, eventType, resource, date range (from/to),
 * with page/limit pagination.
 */
export async function queryAuditEvents(
  client: PrismaClient | Prisma.TransactionClient = prisma,
  options: QueryAuditEventsInput,
): Promise<PaginatedAuditEventsResult> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(100, Math.max(1, options.limit ?? 20));
  const skip = (page - 1) * limit;

  const where: any = {
    communityId: options.communityId,
  };

  if (options.actorWallet) {
    where.walletId = { equals: options.actorWallet, mode: "insensitive" };
  }

  if (options.eventType) {
    where.eventType = options.eventType as EventType;
  }

  if (options.resource) {
    where.resource = options.resource;
  }

  if (options.from || options.to) {
    where.createdAt = {};
    if (options.from) {
      where.createdAt.gte = options.from;
    }
    if (options.to) {
      where.createdAt.lte = options.to;
    }
  }

  const [events, total] = await Promise.all([
    (client as any).auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    (client as any).auditEvent.count({ where }),
  ]);

  return {
    events,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}



