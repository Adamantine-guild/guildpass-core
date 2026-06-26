import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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
  return prisma.auditEvent.create({
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
 * Get audit events for a walletId, newest first. Pagination optional.
 */
export async function getEventsByWallet(walletId: string, limit = 50, cursor?: string) {
  const where: any = { walletId };
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
export async function getEventsByCommunity(communityId: string, limit = 50, cursor?: string) {
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
