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

  // Extract originating on-chain event (first event with blockchain metadata)
  const originatingEvent = auditEvents.find(
    (e) => e.txHash && e.blockNumber !== null && e.logIndex !== null,
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
  const databaseMutations: AuditEventTrace[] = auditEvents.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    walletId: e.walletId,
    communityId: e.communityId,
    resource: e.resource,
    policyRule: e.policyRule,
    decision: e.decision,
    reasonCode: e.reasonCode,
    beforeState: e.beforeState,
    afterState: e.afterState,
    membershipStateVersion: e.membershipStateVersion,
    roleStateVersion: e.roleStateVersion,
    createdAt: e.createdAt,
    onChainEvent: {
      chainId: e.chainId,
      txHash: e.txHash,
      blockNumber: e.blockNumber,
      logIndex: e.logIndex,
    },
  }));

  // Map outbox events to trace format
  const outboxEventTraces: OutboxEventTrace[] = outboxEvents.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    entityId: e.entityId,
    entityType: e.entityType,
    communityId: e.communityId,
    payload: e.payload,
    status: e.status,
    createdAt: e.createdAt,
    deliveredAt: e.deliveredAt,
    onChainEvent: {
      chainId: e.chainId,
      txHash: e.txHash,
      blockNumber: e.blockNumber,
      logIndex: e.logIndex,
    },
  }));

  // Extract access decisions (ACCESS_CHECK events)
  const accessDecisions: AccessDecisionTrace[] = auditEvents
    .filter((e) => e.eventType === 'ACCESS_CHECK')
    .map((e) => ({
      decision: e.decision,
      resource: e.resource,
      policyRule: e.policyRule,
      reasonCode: e.reasonCode,
      membershipState: e.membershipStateVersion
        ? JSON.parse(e.membershipStateVersion)
        : null,
      roleState: e.roleStateVersion ? JSON.parse(e.roleStateVersion) : null,
      auditEvent: databaseMutations.find((m) => m.id === e.id)!,
    }));

  // Build summary
  const eventTypes = [...new Set(auditEvents.map((e) => e.eventType))];

  return {
    correlationId,
    originatingOnChainEvent,
    databaseMutations,
    outboxEvents: outboxEventTraces,
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
 * Finds all correlation IDs associated with a specific blockchain transaction,
 * then returns complete traces for each.
 *
 * @param txHash - Transaction hash
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
 * Query audit traces by wallet address
 *
 * Finds recent audit traces involving a specific wallet in a community.
 *
 * @param walletId - Wallet address
 * @param communityId - Community ID
 * @param limit - Maximum number of traces to return (default: 50)
 * @param prisma - Optional PrismaClient instance
 * @returns Array of complete audit traces
 */
export async function getAuditTracesByWallet(
  walletId: string,
  communityId: string,
  limit: number = 50,
  prisma: PrismaClient = getPrisma(),
): Promise<AuditTraceResult[]> {
  // Find recent correlation IDs for this wallet and community
  const auditEvents = await prisma.auditEvent.findMany({
    where: { 
      walletId: walletId.toLowerCase(),
      communityId: communityId,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
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
 * Format audit trace as human-readable text
 *
 * @param trace - Audit trace result
 * @returns Formatted string representation
 */
export function formatAuditTrace(trace: AuditTraceResult): string {
  const lines: string[] = [];

  lines.push(`=== Audit Trace: ${trace.correlationId} ===`);
  lines.push('');

  // Summary
  lines.push('Summary:');
  lines.push(`  Total Events: ${trace.summary.totalEvents}`);
  lines.push(`  Has On-Chain Origin: ${trace.summary.hasOnChainOrigin}`);
  lines.push(`  Event Types: ${trace.summary.eventTypes.join(', ')}`);
  lines.push('');

  // Originating on-chain event
  if (trace.originatingOnChainEvent) {
    lines.push('Originating On-Chain Event:');
    lines.push(`  Chain ID: ${trace.originatingOnChainEvent.chainId}`);
    lines.push(`  Transaction Hash: ${trace.originatingOnChainEvent.txHash}`);
    lines.push(`  Block Number: ${trace.originatingOnChainEvent.blockNumber}`);
    lines.push(`  Log Index: ${trace.originatingOnChainEvent.logIndex}`);
    lines.push('');
  }

  // Database mutations
  if (trace.databaseMutations.length > 0) {
    lines.push('Database Mutations:');
    trace.databaseMutations.forEach((mutation, i) => {
      lines.push(`  [${i + 1}] ${mutation.eventType} (${mutation.id})`);
      lines.push(`      Wallet: ${mutation.walletId || 'N/A'}`);
      lines.push(`      Community: ${mutation.communityId || 'N/A'}`);
      lines.push(`      Resource: ${mutation.resource || 'N/A'}`);
      lines.push(`      Created At: ${mutation.createdAt.toISOString()}`);
      if (mutation.onChainEvent.txHash) {
        lines.push(`      On-Chain: ${mutation.onChainEvent.txHash}`);
      }
    });
    lines.push('');
  }

  // Outbox events
  if (trace.outboxEvents.length > 0) {
    lines.push('Outbox Events:');
    trace.outboxEvents.forEach((event, i) => {
      lines.push(`  [${i + 1}] ${event.eventType} (${event.id})`);
      lines.push(`      Entity: ${event.entityType} (${event.entityId})`);
      lines.push(`      Status: ${event.status}`);
      lines.push(`      Created At: ${event.createdAt.toISOString()}`);
    });
    lines.push('');
  }

  // Access decisions
  if (trace.accessDecisions.length > 0) {
    lines.push('Access Decisions:');
    trace.accessDecisions.forEach((decision, i) => {
      lines.push(`  [${i + 1}] ${decision.decision} - ${decision.resource}`);
      lines.push(`      Policy Rule: ${decision.policyRule || 'N/A'}`);
      lines.push(`      Reason: ${decision.reasonCode || 'N/A'}`);
      if (decision.membershipState) {
        lines.push(
          `      Membership State: ${JSON.stringify(decision.membershipState)}`,
        );
      }
      if (decision.roleState) {
        lines.push(`      Role State: ${JSON.stringify(decision.roleState)}`);
      }
    });
  }

  return lines.join('\n');
}
