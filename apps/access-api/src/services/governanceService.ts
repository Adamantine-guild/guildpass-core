/**
 * Governance Service
 *
 * Integrates the Constitutional Rule Engine with the access-api.
 * Provides governance rule management and evaluation.
 */

import { PrismaClient } from '@prisma/client';
import {
  RuleNode,
  GovernanceRule,
  ApprovalRecord,
  validateRuleAST,
  evaluateRule,
  createGovernanceContext,
  EvaluationResult,
  DEFAULT_CONTRIBUTION_SCORE,
  ContributionScore,
} from '@guildpass/governance-engine';
import { RoleContext } from '@guildpass/shared-types';
import { getPrisma } from './prisma';

export interface CreateGovernanceRuleInput {
  name: string;
  description: string;
  communityId: string;
  resource: string;
  ast: RuleNode;
}

export interface UpdateGovernanceRuleInput {
  id: string;
  name?: string;
  description?: string;
  ast?: RuleNode;
  active?: boolean;
}

export interface CreateApprovalRequestInput {
  communityId: string;
  resource: string;
  requesterWallet: string;
  ruleId: string;
  expiresAt?: Date;
}

export interface SubmitApprovalInput {
  requestId: string;
  approverWallet: string;
  approverRole: string;
  approved: boolean;
  signature?: string;
}

export interface GovernanceEvaluationInput {
  ruleId: string;
  wallet: string;
  communityId: string;
  roleContext: RoleContext;
  requestId?: string;
}

/**
 * Governance Service
 */
export class GovernanceService {
  constructor(private prisma: PrismaClient = getPrisma()) {}

  /**
   * Create a new governance rule
   */
  async createRule(input: CreateGovernanceRuleInput): Promise<GovernanceRule> {
    // Validate AST
    const validation = validateRuleAST(input.ast);
    if (!validation.valid) {
      throw new Error(`Invalid rule AST: ${validation.errors.join(', ')}`);
    }

    const rule = await this.prisma.governanceRule.create({
      data: {
        name: input.name,
        description: input.description,
        communityId: input.communityId,
        resource: input.resource,
        ast: input.ast as any,
        active: true,
      },
    });

    return {
      id: rule.id,
      name: rule.name,
      description: rule.description,
      communityId: rule.communityId,
      resource: rule.resource,
      ast: rule.ast as unknown as RuleNode,
      active: rule.active,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    };
  }

  /**
   * Update an existing governance rule
   */
  async updateRule(input: UpdateGovernanceRuleInput): Promise<GovernanceRule> {
    // Validate AST if provided
    if (input.ast) {
      const validation = validateRuleAST(input.ast);
      if (!validation.valid) {
        throw new Error(`Invalid rule AST: ${validation.errors.join(', ')}`);
      }
    }

    const data: any = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.ast !== undefined) data.ast = input.ast;
    if (input.active !== undefined) data.active = input.active;

    const rule = await this.prisma.governanceRule.update({
      where: { id: input.id },
      data,
    });

    return {
      id: rule.id,
      name: rule.name,
      description: rule.description,
      communityId: rule.communityId,
      resource: rule.resource,
      ast: rule.ast as unknown as RuleNode,
      active: rule.active,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    };
  }

  /**
   * Get a governance rule by ID
   */
  async getRule(id: string): Promise<GovernanceRule | null> {
    const rule = await this.prisma.governanceRule.findUnique({
      where: { id },
    });

    if (!rule) return null;

    return {
      id: rule.id,
      name: rule.name,
      description: rule.description,
      communityId: rule.communityId,
      resource: rule.resource,
      ast: rule.ast as unknown as RuleNode,
      active: rule.active,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    };
  }

  /**
   * List governance rules for a community
   */
  async listRules(
    communityId: string,
    resource?: string,
    activeOnly: boolean = true,
  ): Promise<GovernanceRule[]> {
    const where: any = { communityId };
    if (resource) where.resource = resource;
    if (activeOnly) where.active = true;

    const rules = await this.prisma.governanceRule.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      communityId: rule.communityId,
      resource: rule.resource,
      ast: rule.ast as unknown as RuleNode,
      active: rule.active,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    }));
  }

  /**
   * Delete a governance rule
   */
  async deleteRule(id: string): Promise<void> {
    await this.prisma.governanceRule.delete({
      where: { id },
    });
  }

  /**
   * Create an approval request
   */
  async createApprovalRequest(input: CreateApprovalRequestInput) {
    return await this.prisma.approvalRequest.create({
      data: {
        communityId: input.communityId,
        resource: input.resource,
        requesterWallet: input.requesterWallet,
        ruleId: input.ruleId,
        expiresAt: input.expiresAt,
        status: 'pending',
      },
    });
  }

  /**
   * Submit an approval (approve or reject)
   */
  async submitApproval(input: SubmitApprovalInput) {
    // Check if approval already exists from this wallet
    const existing = await this.prisma.approval.findUnique({
      where: {
        requestId_approverWallet: {
          requestId: input.requestId,
          approverWallet: input.approverWallet,
        },
      },
    });

    if (existing) {
      throw new Error('Approval already submitted by this wallet');
    }

    // Create approval
    const approval = await this.prisma.approval.create({
      data: {
        requestId: input.requestId,
        approverWallet: input.approverWallet,
        approverRole: input.approverRole,
        approved: input.approved,
        signature: input.signature,
      },
    });

    // Check if we have enough approvals to auto-approve the request
    await this.checkAndUpdateRequestStatus(input.requestId);

    return approval;
  }

  /**
   * Get approvals for a request
   */
  async getApprovals(requestId: string): Promise<ApprovalRecord[]> {
    const approvals = await this.prisma.approval.findMany({
      where: { requestId },
    });

    return approvals.map((a) => ({
      id: a.id,
      requestId: a.requestId,
      approverWallet: a.approverWallet,
      approverRole: a.approverRole as any,
      approved: a.approved,
      timestamp: a.timestamp,
      signature: a.signature || undefined,
    }));
  }

  /**
   * Get contribution score for a wallet in a community
   */
  async getContributionScore(
    walletId: string,
    communityId: string,
  ): Promise<ContributionScore> {
    const score = await this.prisma.contributionScore.findUnique({
      where: {
        walletId_communityId: {
          walletId,
          communityId,
        },
      },
    });

    if (!score) {
      return DEFAULT_CONTRIBUTION_SCORE;
    }

    return {
      total: score.totalScore,
      breakdown: score.breakdown as any,
    };
  }

  /**
   * Update contribution score
   */
  async updateContributionScore(
    walletId: string,
    communityId: string,
    totalScore: number,
    breakdown?: any,
  ) {
    return await this.prisma.contributionScore.upsert({
      where: {
        walletId_communityId: {
          walletId,
          communityId,
        },
      },
      update: {
        totalScore,
        breakdown: breakdown || {},
      },
      create: {
        walletId,
        communityId,
        totalScore,
        breakdown: breakdown || {},
      },
    });
  }

  /**
   * Evaluate a governance rule
   */
  async evaluateGovernanceRule(input: GovernanceEvaluationInput): Promise<EvaluationResult> {
    // Get the rule
    const rule = await this.getRule(input.ruleId);
    if (!rule) {
      throw new Error(`Governance rule not found: ${input.ruleId}`);
    }

    if (!rule.active) {
      throw new Error(`Governance rule is inactive: ${input.ruleId}`);
    }

    // Get contribution score
    const contributionScore = await this.getContributionScore(
      input.wallet,
      input.communityId,
    );

    // Get approvals if requestId provided
    const approvals = input.requestId
      ? await this.getApprovals(input.requestId)
      : [];

    // Create governance context
    const context = createGovernanceContext(
      input.wallet,
      input.communityId,
      input.roleContext,
      contributionScore,
      approvals,
      input.requestId,
    );

    // Evaluate rule
    return evaluateRule(rule.ast, context);
  }

  /**
   * Check approval request status and update if threshold met
   */
  private async checkAndUpdateRequestStatus(requestId: string): Promise<void> {
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id: requestId },
      include: { approvals: true },
    });

    if (!request || request.status !== 'pending') {
      return;
    }

    // Get the rule to check threshold
    const rule = await this.getRule(request.ruleId);
    if (!rule) return;

    // This is a simplified check - in production, you'd parse the AST
    // to find RequiresApprovals nodes and check their thresholds
    const approvedCount = request.approvals.filter((a) => a.approved).length;
    const rejectedCount = request.approvals.filter((a) => !a.approved).length;

    // Simple logic: if any rejection, mark as rejected
    // If enough approvals (simplified: assume threshold of 2), mark as approved
    if (rejectedCount > 0) {
      await this.prisma.approvalRequest.update({
        where: { id: requestId },
        data: { status: 'rejected' },
      });
    } else if (approvedCount >= 2) {
      // Simplified threshold
      await this.prisma.approvalRequest.update({
        where: { id: requestId },
        data: { status: 'approved' },
      });
    }
  }
}

export function getGovernanceService(prisma?: PrismaClient): GovernanceService {
  return new GovernanceService(prisma);
}
