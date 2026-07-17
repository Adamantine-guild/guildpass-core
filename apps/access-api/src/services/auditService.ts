import { PrismaClient } from "@prisma/client";

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
 * Persist an audit event to the DB.
 */
export async function logEvent(event: AuditEventInput) {
  return logEventTx(prisma, event);
}

/**
 * Transaction-aware audit event creation.
 *
 * Important: we run this inside the caller's Prisma transaction so audit events
 * cannot cause partial visibility of access-affecting mutations.
 *
 * Also emits a durable outbox event for ACCESS_CHECK decisions so downstream
 * integrations (dashboards, bots, webhooks, analytics) can consume them
 * reliably.
 */
export async function logEventTx(db: PrismaLikeClient, event: AuditEventInput) {
  // Create audit event and optionally an outbox event in parallel within
  // the same transaction for atomicity.
  const promises: Promise<any>[] = [
    db.auditEvent.create({
      data: {
        eventType: event.eventType,
        walletId: event.walletId ?? null,
        communityId: event.communityId ?? null,
        resource: event.resource ?? null,
        policyRule: event.policyRule ?? null,
        decision: event.decision ?? null,
        reasonCode: event.reasonCode ?? null,
        beforeState: event.beforeState ?? null,
        afterState: event.afterState ?? null,
        correlationId: event.correlationId ?? null,
        chainId: event.chainId ?? null,
        txHash: event.txHash ?? null,
        blockNumber: event.blockNumber ?? null,
        logIndex: event.logIndex ?? null,
        membershipStateVersion: event.membershipStateVersion ?? null,
        roleStateVersion: event.roleStateVersion ?? null,
      },
    }),
  ];

  // Also emit a durable outbox event for ACCESS_CHECK decisions so
  // downstream integrations can consume them reliably.
  if (
    db.outboxEvent &&
    event.eventType === "ACCESS_CHECK"
  ) {
    promises.push(
      db.outboxEvent.create({
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
      }),
    );
  }

  const [auditResult] = await Promise.all(promises);
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


