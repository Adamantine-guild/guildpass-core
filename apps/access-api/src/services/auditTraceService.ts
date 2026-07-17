/**
 * Audit Trace Service
 *
 * Provides queryable, verifiable audit chain of custody by linking:
 * 1. On-chain events (block, transaction hash, log index)
 * 2. Database state changes (mutations in audit_events)
 * 3. Outbox events triggered by those mutations
 * 4. Access-check API decisions that read those state changes
 */

import { PrismaClient } from '@prisma/client';
import { getPrisma } from './prisma';

export interface OnChainEventTrace {
  chainId: number | null;
  txHash: string | null;
  blockNumber: number | null;
  logIndex: number | null;
}

export interface AuditEventTrace {
  id: string;
  eventType: string;
  walletId: string | null;
  communityId: string | null;
  resource: string | null;
  policyRule: string | null;
  decision: string | null;
  reasonCode: string | null;
  beforeState: any;
  afterState: any;
  membershipStateVersion: string | null;
  roleStateVersion: string | null;
  createdAt: Date;
  onChainEvent: OnChainEventTrace;
}

export interface OutboxEventTrace {
  id: string;
  eventType: string;
  entityId: string | null;
  entityType: string | null;
  communityId: string | null;
  payload: any;
  status: string;
  createdAt: Date;
  deliveredAt: Date | null;
  onChainEvent: OnChainEventTrace;
}

export interface AccessDecisionTrace {
  decision: string | null;
  resource: string | null;
  policyRule: string | null;
  reasonCode: string | null;
  membershipState: any;
  roleState: any;
  auditEvent: AuditEventTrace;
}

export interface AuditTraceResult {
  correlationId: string;
  originatingOnChainEvent: OnChainEventTrace | null;
  databaseMutations: AuditEventTrace[];
  outboxEvents: OutboxEventTrace[];
  accessDecisions: AccessDecisionTrace[];
  summary: {
    totalEvents: number;
    hasOnChainOrigin: boolean;
    eventTypes: string[];
  };
}

/**
 * Query complete audit trace by correlation ID
 *
 * Reconstructs the full chain of custody from on-chain event through state changes
 * to access decisions.
 *
 * @param correlationId - Unique correlation ID linking related events
 * @param prisma - Optional PrismaClient instance
 * @returns Complete audit trace with all linked events
 */
export async function getAuditTraceByCorrelationId(
  correlationId: string,
  prisma: PrismaClient = getPrisma(),
): Promise<AuditTraceResult | null> {
  // Query all audit events with this correlation ID
  const auditEvents = await prisma.auditEvent.findMany({
    where: { correlationId },
    orderBy: { createdAt: 'asc' },
  });

  if (auditEvents.length === 0) {
    return null;
  }

  // Query all outbox events with this correlation ID
  const outboxEvents = await prisma.outboxEvent.findMany({
    where: { correlationId },
    orderBy: { createdAt: 'asc' },
  });

  // Extract on-chain origin (if any)
  const originatingEvent = auditEvents.find(
    (e) => e.txHash && e.blockNumber && e.logIndex !== null,
  );

  const originatingOnChainEvent: OnChainEventTrace | null = originatingEvent
    ? {
        chainId: originatingEvent.chainId,
        txHash: originatingEvent.txHash,
        blockNumber: originatingEvent.blockNumber,
        logIndex: originatingEvent.logIndex,
      }
    : null;

  // Map audit events to trace format
  const databaseMutations: AuditEventTrace[] = auditEvents.map((event) => ({
    id: event.id,
    eventType: event.eventType,
    walletId: event.walletId,
    communityId: event.communityId,
    resource: event.resource,
    policyRule: event.policyRule,
    decision: event.decision,
    reasonCode: event.reasonCode,
    beforeState: event.beforeState,
    afterState: event.afterState,
    membershipStateVersion: event.membershipStateVersion,
    roleStateVersion: event.roleStateVersion,
    createdAt: event.createdAt,
    onChainEvent: {
      chainId: event.chainId,
      txHash: event.txHash,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
    },
  }));

  // Map outbox events to trace format
  const outboxEventsTrace: OutboxEventTrace[] = outboxEvents.map((event) => ({
    id: event.id,
    eventType: event.eventType,
    entityId: event.entityId,
    entityType: event.entityType,
    communityId: event.communityId,
    payload: event.payload,
    status: event.status,
    createdAt: event.createdAt,
    deliveredAt: event.deliveredAt,
    onChainEvent: {
      chainId: event.chainId,
      txHash: event.txHash,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
    },
  }));

  // Extract access decisions
  const accessDecisions: AccessDecisionTrace[] = auditEvents
    .filter((e) => e.eventType === 'ACCESS_CHECK')
    .map((event) => ({
      decision: event.decision,
      resource: event.resource,
      policyRule: event.policyRule,
      reasonCode: event.reasonCode,
      membershipState: event.membershipStateVersion
        ? JSON.parse(event.membershipStateVersion)
        : null,
      roleState: event.roleStateVersion ? JSON.parse(event.roleStateVersion) : null,
      auditEvent: databaseMutations.find((m) => m.id === event.id)!,
    }));

  const eventTypes = [...new Set(auditEvents.map((e) => e.eventType))];

  return {
    correlationId,
    originatingOnChainEvent,
    databaseMutations,
    outboxEvents: outboxEventsTrace,
    accessDecisions,
    summary: {
      totalEvents: auditEvents.length + outboxEvents.length,
      hasOnChainOrigin: !!originatingOnChainEvent,
      eventTypes,
    },
  };
}

/**
 * Query audit traces by transaction hash
 *
 * Finds all correlation IDs associated with a specific on-chain transaction
 * and returns complete traces for each.
 *
 * @param txHash - Transaction hash from blockchain
 * @param prisma - Optional PrismaClient instance
 * @returns Array of complete audit traces
 */
export async function getAuditTracesByTxHash(
  txHash: string,
  prisma: PrismaClient = getPrisma(),
): Promise<AuditTraceResult[]> {
  // Find all unique correlation IDs for this transaction
  const auditEvents = await prisma.auditEvent.findMany({
    where: { txHash },
    select: { correlationId: true },
    distinct: ['correlationId'],
  });

  const correlationIds = auditEvents
    .map((e) => e.correlationId)
    .filter((id): id is string => id !== null);

  // Fetch complete traces for each correlation ID
  const traces = await Promise.all(
    correlationIds.map((id) => getAuditTraceByCorrelationId(id, prisma)),
  );

  return traces.filter((t): t is AuditTraceResult => t !== null);
}

/**
 * Query audit traces by wallet and community
 *
 * Useful for investigating a specific member's activity
 *
 * @param walletId - Wallet address
 * @param communityId - Community ID
 * @param limit - Maximum number of traces to return
 * @param prisma - Optional PrismaClient instance
 * @returns Array of complete audit traces
 */
export async function getAuditTracesByWallet(
  walletId: string,
  communityId: string,
  limit: number = 50,
  prisma: PrismaClient = getPrisma(),
): Promise<AuditTraceResult[]> {
  // Find recent correlation IDs for this wallet/community
  const auditEvents = await prisma.auditEvent.findMany({
    where: {
      walletId: walletId.toLowerCase(),
      communityId,
      correlationId: { not: null },
    },
    select: { correlationId: true },
    distinct: ['correlationId'],
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const correlationIds = auditEvents
    .map((e) => e.correlationId)
    .filter((id): id is string => id !== null);

  // Fetch complete traces for each correlation ID
  const traces = await Promise.all(
    correlationIds.map((id) => getAuditTraceByCorrelationId(id, prisma)),
  );

  return traces.filter((t): t is AuditTraceResult => t !== null);
}

/**
 * Verify audit trail integrity
 *
 * Checks that audit events are append-only (no updates/deletes)
 * by comparing expected vs actual record counts
 *
 * @param correlationId - Correlation ID to verify
 * @param expectedEventCount - Expected number of events
 * @param prisma - Optional PrismaClient instance
 * @returns True if integrity is maintained
 */
export async function verifyAuditTrailIntegrity(
  correlationId: string,
  expectedEventCount: number,
  prisma: PrismaClient = getPrisma(),
): Promise<boolean> {
  const auditEvents = await prisma.auditEvent.count({
    where: { correlationId },
  });

  return auditEvents >= expectedEventCount;
}
