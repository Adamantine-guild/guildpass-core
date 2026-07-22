/**
 * Constitutional Service
 *
 * Integrates @guildpass/constitutional-engine with Prisma database persistence,
 * per-community rule-set versioning, mutation validation hooks, and audit event logging.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import {
  ConstitutionalEngine,
  ConstitutionalRule,
  ConstitutionalRuleSet,
  EvaluationResult,
  MutationContext,
  MutationType,
  validateRuleSet,
} from '@guildpass/constitutional-engine';
import { createOutboxEvent } from './outboxService';

export class ConstitutionalViolationError extends Error {
  public statusCode: number = 403;
  public code: string;
  public reasons: Array<{ code: string; message: string }>;
  public traces: any[];

  constructor(
    message: string,
    code: string,
    reasons: Array<{ code: string; message: string }>,
    traces: any[],
  ) {
    super(message);
    this.name = 'ConstitutionalViolationError';
    this.code = code;
    this.reasons = reasons;
    this.traces = traces;
  }
}

const engine = new ConstitutionalEngine();

/**
 * Fetch the active ConstitutionalRuleSet for a community
 */
export async function getActiveConstitutionalRuleSet(
  prisma: PrismaClient | Prisma.TransactionClient,
  communityId: string,
): Promise<ConstitutionalRuleSet | null> {
  const record = await prisma.constitutionalRuleSet.findFirst({
    where: {
      communityId,
      active: true,
    },
    orderBy: {
      version: 'desc',
    },
  });

  if (!record) return null;

  return {
    id: record.id,
    communityId: record.communityId,
    version: record.version,
    rules: (record.rules as any as ConstitutionalRule[]) || [],
    createdBy: record.createdBy || undefined,
    createdAt: record.createdAt,
    active: record.active,
  };
}

/**
 * Create a new versioned ConstitutionalRuleSet for a community
 */
export async function createConstitutionalRuleSet(
  prisma: PrismaClient,
  params: {
    communityId: string;
    rules: ConstitutionalRule[];
    createdBy?: string;
    description?: string;
  },
): Promise<ConstitutionalRuleSet> {
  // Find highest version currently existing for community
  const latest = await prisma.constitutionalRuleSet.findFirst({
    where: { communityId: params.communityId },
    orderBy: { version: 'desc' },
  });

  const newVersion = (latest?.version || 0) + 1;

  const candidateRuleSet: ConstitutionalRuleSet = {
    id: 'draft',
    communityId: params.communityId,
    version: newVersion,
    rules: params.rules,
    createdBy: params.createdBy,
    description: params.description,
  };

  const validation = validateRuleSet(candidateRuleSet);
  if (!validation.valid) {
    const errorDetails = validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`Invalid Constitutional RuleSet: ${errorDetails}`);
  }

  return await prisma.$transaction(async (tx) => {
    // Deactivate previous rule sets
    await tx.constitutionalRuleSet.updateMany({
      where: { communityId: params.communityId, active: true },
      data: { active: false },
    });

    // Create new version
    const created = await tx.constitutionalRuleSet.create({
      data: {
        communityId: params.communityId,
        version: newVersion,
        rules: params.rules as any,
        active: true,
        description: params.description,
        createdBy: params.createdBy,
      },
    });

    // Write audit event
    await tx.auditEvent.create({
      data: {
        eventType: 'OTHER',
        communityId: params.communityId,
        walletId: params.createdBy,
        decision: 'ALLOW',
        reasonCode: 'CONSTITUTIONAL_RULESET_CREATED',
        afterState: {
          ruleSetId: created.id,
          version: created.version,
          ruleCount: params.rules.length,
        },
      },
    });

    // Write outbox event
    await createOutboxEvent(tx, {
      eventType: 'CONSTITUTIONAL_RULESET_CREATED',
      entityId: created.id,
      entityType: 'ConstitutionalRuleSet',
      communityId: params.communityId,
      payload: {
        id: created.id,
        version: created.version,
        communityId: params.communityId,
        createdBy: params.createdBy,
      },
    });

    return {
      id: created.id,
      communityId: created.communityId,
      version: created.version,
      rules: (created.rules as any as ConstitutionalRule[]) || [],
      createdBy: created.createdBy || undefined,
      createdAt: created.createdAt,
      active: created.active,
    };
  });
}

/**
 * Get all versions of ConstitutionalRuleSets for a community
 */
export async function getConstitutionalRuleSetVersions(
  prisma: PrismaClient | Prisma.TransactionClient,
  communityId: string,
) {
  const records = await prisma.constitutionalRuleSet.findMany({
    where: { communityId },
    orderBy: { version: 'desc' },
  });

  return records.map((record) => ({
    id: record.id,
    communityId: record.communityId,
    version: record.version,
    rules: record.rules,
    active: record.active,
    description: record.description,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
  }));
}

/**
 * Validate and evaluate a mutation against the active ConstitutionalRuleSet inside a transaction
 */
export async function validateAndEvaluateMutation(
  tx: Prisma.TransactionClient,
  params: {
    action: MutationType;
    communityId: string;
    actorWallet: string;
    targetWallet?: string;
    targetResource?: string;
    proposedData?: Record<string, any>;
    approvals?: Array<{ wallet: string; role: string; timestamp: Date | string }>;
    correlationId?: string;
  },
): Promise<EvaluationResult> {
  const activeRuleSet = await getActiveConstitutionalRuleSet(tx, params.communityId);

  if (!activeRuleSet) {
    return {
      allowed: true,
      code: 'CONSTITUTIONAL_ALLOW',
      reasons: [
        {
          code: 'NO_ACTIVE_RULESET',
          message: `No active constitutional rule set configured for community ${params.communityId}`,
        },
      ],
      traces: [],
    };
  }

  // Look up most recent mutation audit event for this target to check cooldowns
  const lastMutation = await tx.auditEvent.findFirst({
    where: {
      communityId: params.communityId,
      reasonCode: { in: ['ROLE_ASSIGNED', 'ROLE_REMOVED', 'POLICY_CREATED', 'ACCESS_OVERRIDE_CREATED'] },
      ...(params.targetWallet ? { walletId: params.targetWallet } : {}),
      ...(params.targetResource ? { resource: params.targetResource } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

  const previousMutationTimestamp = lastMutation ? lastMutation.createdAt : null;

  const mutationContext: MutationContext = {
    action: params.action,
    communityId: params.communityId,
    actorWallet: params.actorWallet,
    targetWallet: params.targetWallet,
    targetResource: params.targetResource,
    proposedData: params.proposedData,
    previousMutationTimestamp,
    approvals: params.approvals,
  };

  const evaluationResult = engine.evaluate(activeRuleSet, mutationContext);

  // Write audit event recording the constitutional check
  await tx.auditEvent.create({
    data: {
      eventType: 'OTHER',
      communityId: params.communityId,
      walletId: params.actorWallet,
      resource: params.targetResource,
      decision: evaluationResult.allowed ? 'ALLOW' : 'DENY',
      reasonCode: evaluationResult.code,
      correlationId: params.correlationId,
      afterState: {
        action: params.action,
        targetWallet: params.targetWallet,
        reasons: evaluationResult.reasons,
        traces: evaluationResult.traces,
      },
    },
  });

  if (!evaluationResult.allowed) {
    const mainReason = evaluationResult.reasons[0]?.message || 'Constitutional rule violation';
    throw new ConstitutionalViolationError(
      `Constitutional Violation: ${mainReason}`,
      evaluationResult.code,
      evaluationResult.reasons,
      evaluationResult.traces,
    );
  }

  return evaluationResult;
}
