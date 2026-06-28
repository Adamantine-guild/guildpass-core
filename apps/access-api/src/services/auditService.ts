import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Transaction-scoped Prisma clients expose an auditEvent model.
// We keep this intentionally loose so callers can pass Prisma's transaction client.
type AuditEventClient = {
  create: (args: any) => any;
};

type PrismaLikeClient = {
  auditEvent: AuditEventClient;
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
 */
export async function logEventTx(db: PrismaLikeClient, event: AuditEventInput) {
  return db.auditEvent.create({

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
    },
  });
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


