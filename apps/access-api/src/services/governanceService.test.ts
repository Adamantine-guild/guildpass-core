/**
 * Unit tests for GovernanceService
 *
 * Mocking conventions follow memberService.test.ts:
 *   - mockPrisma is a plain object with jest.fn() for each method used
 *   - cast as unknown as PrismaClient and pass directly to the service constructor
 *   - jest.clearAllMocks() in beforeEach
 */

import { PrismaClient } from '@prisma/client';
import { getGovernanceService } from './governanceService';
import type { RuleNode } from '@guildpass/governance-engine';

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  governanceRule: {
    create: jest.fn(),
    update: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    delete: jest.fn(),
  },
  approvalRequest: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  approval: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  contributionScore: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
} as unknown as PrismaClient;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_HAS_ROLE_AST: RuleNode = { type: 'HasRole', role: 'member' };

const VALID_AND_AST: RuleNode = {
  type: 'AND',
  rules: [
    { type: 'HasRole', role: 'admin' },
    { type: 'HasMembershipState', state: 'active' },
  ],
};

const now = new Date();

function makeDbRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    description: 'A test rule',
    communityId: 'community-1',
    resource: 'dashboard',
    ast: VALID_HAS_ROLE_AST,
    active: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GovernanceService', () => {
  let service: ReturnType<typeof getGovernanceService>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = getGovernanceService(mockPrisma);
  });

  // -------------------------------------------------------------------------
  // createRule
  // -------------------------------------------------------------------------

  describe('createRule', () => {
    test('success: creates a rule with a valid HasRole AST', async () => {
      (mockPrisma.governanceRule.create as jest.Mock).mockResolvedValue(makeDbRule());

      const result = await service.createRule({
        name: 'Test Rule',
        description: 'A test rule',
        communityId: 'community-1',
        resource: 'dashboard',
        ast: VALID_HAS_ROLE_AST,
      });

      expect(result.id).toBe('rule-1');
      expect(result.name).toBe('Test Rule');
      expect(result.active).toBe(true);
      expect(mockPrisma.governanceRule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Test Rule',
            communityId: 'community-1',
            resource: 'dashboard',
            active: true,
          }),
        }),
      );
    });

    test('success: creates a rule with a valid AND AST', async () => {
      (mockPrisma.governanceRule.create as jest.Mock).mockResolvedValue(
        makeDbRule({ ast: VALID_AND_AST }),
      );

      const result = await service.createRule({
        name: 'AND Rule',
        description: 'Composite rule',
        communityId: 'community-1',
        resource: 'admin-panel',
        ast: VALID_AND_AST,
      });

      expect(result.id).toBe('rule-1');
      expect(mockPrisma.governanceRule.create).toHaveBeenCalledTimes(1);
    });

    test('failure: throws on invalid AST type', async () => {
      const badAst = { type: 'UnknownType' } as unknown as RuleNode;

      await expect(
        service.createRule({
          name: 'Bad Rule',
          description: 'desc',
          communityId: 'community-1',
          resource: 'res',
          ast: badAst,
        }),
      ).rejects.toThrow('Invalid rule AST');

      expect(mockPrisma.governanceRule.create).not.toHaveBeenCalled();
    });

    test('failure: throws on invalid role in HasRole node', async () => {
      const badAst = { type: 'HasRole', role: 'owner' } as unknown as RuleNode;

      await expect(
        service.createRule({
          name: 'Bad Role Rule',
          description: 'desc',
          communityId: 'community-1',
          resource: 'res',
          ast: badAst,
        }),
      ).rejects.toThrow('Invalid rule AST');

      expect(mockPrisma.governanceRule.create).not.toHaveBeenCalled();
    });

    test('failure: throws on HasRole node missing role property', async () => {
      const badAst = { type: 'HasRole' } as unknown as RuleNode;

      await expect(
        service.createRule({
          name: 'Missing role',
          description: 'desc',
          communityId: 'community-1',
          resource: 'res',
          ast: badAst,
        }),
      ).rejects.toThrow('Invalid rule AST');
    });

    test('failure: throws on invalid membership state in HasMembershipState node', async () => {
      const badAst = {
        type: 'HasMembershipState',
        state: 'banned',
      } as unknown as RuleNode;

      await expect(
        service.createRule({
          name: 'Bad State Rule',
          description: 'desc',
          communityId: 'community-1',
          resource: 'res',
          ast: badAst,
        }),
      ).rejects.toThrow('Invalid rule AST');
    });

    test('failure: throws on deeply nested AST exceeding max depth', async () => {
      // Build a chain of NOT nodes deeper than MAX_DEPTH (10)
      let deepAst: RuleNode = { type: 'HasRole', role: 'member' };
      for (let i = 0; i < 12; i++) {
        deepAst = { type: 'NOT', rule: deepAst };
      }

      await expect(
        service.createRule({
          name: 'Deep Rule',
          description: 'desc',
          communityId: 'community-1',
          resource: 'res',
          ast: deepAst,
        }),
      ).rejects.toThrow('Invalid rule AST');
    });

    test('failure: surfaces validation error message in thrown error', async () => {
      const badAst = { type: 'HasRole', role: 'superuser' } as unknown as RuleNode;

      await expect(
        service.createRule({
          name: 'Bad',
          description: 'desc',
          communityId: 'c-1',
          resource: 'r',
          ast: badAst,
        }),
      ).rejects.toThrow(/Invalid role/);
    });
  });

  // -------------------------------------------------------------------------
  // updateRule
  // -------------------------------------------------------------------------

  describe('updateRule', () => {
    test('success: updates name and description without touching AST', async () => {
      const updated = makeDbRule({ name: 'Renamed Rule' });
      (mockPrisma.governanceRule.update as jest.Mock).mockResolvedValue(updated);

      const result = await service.updateRule({
        id: 'rule-1',
        name: 'Renamed Rule',
        description: 'New desc',
      });

      expect(result.name).toBe('Renamed Rule');
      expect(mockPrisma.governanceRule.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'rule-1' },
          data: expect.objectContaining({ name: 'Renamed Rule', description: 'New desc' }),
        }),
      );
    });

    test('success: updates with a valid new AST', async () => {
      const updated = makeDbRule({ ast: VALID_AND_AST });
      (mockPrisma.governanceRule.update as jest.Mock).mockResolvedValue(updated);

      const result = await service.updateRule({
        id: 'rule-1',
        ast: VALID_AND_AST,
      });

      expect(result.id).toBe('rule-1');
      expect(mockPrisma.governanceRule.update).toHaveBeenCalledTimes(1);
    });

    test('success: deactivates a rule', async () => {
      const updated = makeDbRule({ active: false });
      (mockPrisma.governanceRule.update as jest.Mock).mockResolvedValue(updated);

      const result = await service.updateRule({ id: 'rule-1', active: false });

      expect(result.active).toBe(false);
      expect(mockPrisma.governanceRule.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ active: false }),
        }),
      );
    });

    test('failure: throws on invalid AST when ast is provided', async () => {
      const badAst = { type: 'HasRole', role: 'superadmin' } as unknown as RuleNode;

      await expect(service.updateRule({ id: 'rule-1', ast: badAst })).rejects.toThrow(
        'Invalid rule AST',
      );

      expect(mockPrisma.governanceRule.update).not.toHaveBeenCalled();
    });

    test('skips AST validation when ast is not provided', async () => {
      (mockPrisma.governanceRule.update as jest.Mock).mockResolvedValue(makeDbRule());

      // No ast in input — should not throw and should call update
      await expect(
        service.updateRule({ id: 'rule-1', name: 'Only name change' }),
      ).resolves.toBeDefined();

      expect(mockPrisma.governanceRule.update).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // getRule
  // -------------------------------------------------------------------------

  describe('getRule', () => {
    test('success: returns a rule when found', async () => {
      (mockPrisma.governanceRule.findUnique as jest.Mock).mockResolvedValue(makeDbRule());

      const result = await service.getRule('rule-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('rule-1');
      expect(result!.name).toBe('Test Rule');
      expect(mockPrisma.governanceRule.findUnique).toHaveBeenCalledWith({
        where: { id: 'rule-1' },
      });
    });

    test('failure: returns null when rule not found', async () => {
      (mockPrisma.governanceRule.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.getRule('nonexistent-id');

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // listRules
  // -------------------------------------------------------------------------

  describe('listRules', () => {
    test('success: returns active rules for a community', async () => {
      const rules = [makeDbRule(), makeDbRule({ id: 'rule-2', name: 'Rule 2' })];
      (mockPrisma.governanceRule.findMany as jest.Mock).mockResolvedValue(rules);

      const result = await service.listRules('community-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('rule-1');
      expect(mockPrisma.governanceRule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ communityId: 'community-1', active: true }),
        }),
      );
    });

    test('success: filters by resource when provided', async () => {
      (mockPrisma.governanceRule.findMany as jest.Mock).mockResolvedValue([makeDbRule()]);

      await service.listRules('community-1', 'dashboard');

      expect(mockPrisma.governanceRule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            communityId: 'community-1',
            resource: 'dashboard',
            active: true,
          }),
        }),
      );
    });

    test('success: includes inactive rules when activeOnly is false', async () => {
      const rules = [makeDbRule(), makeDbRule({ id: 'rule-2', active: false })];
      (mockPrisma.governanceRule.findMany as jest.Mock).mockResolvedValue(rules);

      const result = await service.listRules('community-1', undefined, false);

      expect(mockPrisma.governanceRule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.not.objectContaining({ active: true }),
        }),
      );
      expect(result).toHaveLength(2);
    });

    test('failure: returns empty array when no rules match', async () => {
      (mockPrisma.governanceRule.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.listRules('community-unknown');

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // deleteRule
  // -------------------------------------------------------------------------

  describe('deleteRule', () => {
    test('success: deletes a rule by id', async () => {
      (mockPrisma.governanceRule.delete as jest.Mock).mockResolvedValue(makeDbRule());

      await expect(service.deleteRule('rule-1')).resolves.toBeUndefined();

      expect(mockPrisma.governanceRule.delete).toHaveBeenCalledWith({
        where: { id: 'rule-1' },
      });
    });

    test('failure: propagates Prisma error when rule does not exist', async () => {
      (mockPrisma.governanceRule.delete as jest.Mock).mockRejectedValue(
        new Error('Record to delete does not exist'),
      );

      await expect(service.deleteRule('nonexistent')).rejects.toThrow(
        'Record to delete does not exist',
      );
    });
  });

  // -------------------------------------------------------------------------
  // createApprovalRequest
  // -------------------------------------------------------------------------

  describe('createApprovalRequest', () => {
    const baseRequest = {
      id: 'req-1',
      communityId: 'community-1',
      resource: 'dashboard',
      requesterWallet: '0xabc',
      ruleId: 'rule-1',
      status: 'pending',
      expiresAt: null,
      createdAt: now,
    };

    test('success: creates an approval request with pending status', async () => {
      (mockPrisma.approvalRequest.create as jest.Mock).mockResolvedValue(baseRequest);

      const result = await service.createApprovalRequest({
        communityId: 'community-1',
        resource: 'dashboard',
        requesterWallet: '0xabc',
        ruleId: 'rule-1',
      });

      expect(result.id).toBe('req-1');
      expect(result.status).toBe('pending');
      expect(mockPrisma.approvalRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            communityId: 'community-1',
            status: 'pending',
          }),
        }),
      );
    });

    test('success: passes expiresAt when provided', async () => {
      const expiresAt = new Date(Date.now() + 86400000);
      (mockPrisma.approvalRequest.create as jest.Mock).mockResolvedValue({
        ...baseRequest,
        expiresAt,
      });

      await service.createApprovalRequest({
        communityId: 'community-1',
        resource: 'dashboard',
        requesterWallet: '0xabc',
        ruleId: 'rule-1',
        expiresAt,
      });

      expect(mockPrisma.approvalRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ expiresAt }),
        }),
      );
    });

    test('failure: propagates Prisma error', async () => {
      (mockPrisma.approvalRequest.create as jest.Mock).mockRejectedValue(
        new Error('Foreign key constraint failed'),
      );

      await expect(
        service.createApprovalRequest({
          communityId: 'community-1',
          resource: 'res',
          requesterWallet: '0xabc',
          ruleId: 'nonexistent-rule',
        }),
      ).rejects.toThrow('Foreign key constraint failed');
    });
  });

  // -------------------------------------------------------------------------
  // submitApproval
  // -------------------------------------------------------------------------

  describe('submitApproval', () => {
    const baseApproval = {
      id: 'approval-1',
      requestId: 'req-1',
      approverWallet: '0xapprover',
      approverRole: 'admin',
      approved: true,
      signature: null,
      timestamp: now,
    };

    const pendingRequest = {
      id: 'req-1',
      ruleId: 'rule-1',
      status: 'pending',
      approvals: [],
    };

    beforeEach(() => {
      // Default: no existing approval, request is pending, and the rule exists
      (mockPrisma.approval.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.approval.create as jest.Mock).mockResolvedValue(baseApproval);
      (mockPrisma.approvalRequest.findUnique as jest.Mock).mockResolvedValue(pendingRequest);
      (mockPrisma.governanceRule.findUnique as jest.Mock).mockResolvedValue(makeDbRule());
    });

    test('success: creates an approval record', async () => {
      const result = await service.submitApproval({
        requestId: 'req-1',
        approverWallet: '0xapprover',
        approverRole: 'admin',
        approved: true,
      });

      expect(result.id).toBe('approval-1');
      expect(mockPrisma.approval.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            requestId: 'req-1',
            approverWallet: '0xapprover',
            approved: true,
          }),
        }),
      );
    });

    test('success: stores optional signature', async () => {
      (mockPrisma.approval.create as jest.Mock).mockResolvedValue({
        ...baseApproval,
        signature: '0xsig',
      });

      await service.submitApproval({
        requestId: 'req-1',
        approverWallet: '0xapprover',
        approverRole: 'admin',
        approved: true,
        signature: '0xsig',
      });

      expect(mockPrisma.approval.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ signature: '0xsig' }),
        }),
      );
    });

    test('failure: throws when the same wallet submits twice', async () => {
      (mockPrisma.approval.findUnique as jest.Mock).mockResolvedValue(baseApproval);

      await expect(
        service.submitApproval({
          requestId: 'req-1',
          approverWallet: '0xapprover',
          approverRole: 'admin',
          approved: true,
        }),
      ).rejects.toThrow('Approval already submitted by this wallet');

      expect(mockPrisma.approval.create).not.toHaveBeenCalled();
    });

    test('auto-updates request to approved when >= 2 approvals exist', async () => {
      const approvedRequest = {
        ...pendingRequest,
        approvals: [
          { approved: true },
          { approved: true },
        ],
      };
      (mockPrisma.approvalRequest.findUnique as jest.Mock).mockResolvedValue(approvedRequest);
      (mockPrisma.approvalRequest.update as jest.Mock).mockResolvedValue({
        ...approvedRequest,
        status: 'approved',
      });

      await service.submitApproval({
        requestId: 'req-1',
        approverWallet: '0xnewapprover',
        approverRole: 'admin',
        approved: true,
      });

      expect(mockPrisma.approvalRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'req-1' },
          data: { status: 'approved' },
        }),
      );
    });

    test('auto-updates request to rejected on first rejection', async () => {
      const requestWithRejection = {
        ...pendingRequest,
        approvals: [{ approved: false }],
      };
      (mockPrisma.approvalRequest.findUnique as jest.Mock).mockResolvedValue(requestWithRejection);
      (mockPrisma.approvalRequest.update as jest.Mock).mockResolvedValue({
        ...requestWithRejection,
        status: 'rejected',
      });

      await service.submitApproval({
        requestId: 'req-1',
        approverWallet: '0xrejecter',
        approverRole: 'admin',
        approved: false,
      });

      expect(mockPrisma.approvalRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'rejected' },
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getApprovals
  // -------------------------------------------------------------------------

  describe('getApprovals', () => {
    test('success: returns mapped approval records', async () => {
      const dbApprovals = [
        {
          id: 'a-1',
          requestId: 'req-1',
          approverWallet: '0xwallet1',
          approverRole: 'admin',
          approved: true,
          timestamp: now,
          signature: null,
        },
        {
          id: 'a-2',
          requestId: 'req-1',
          approverWallet: '0xwallet2',
          approverRole: 'contributor',
          approved: false,
          timestamp: now,
          signature: '0xsig',
        },
      ];
      (mockPrisma.approval.findMany as jest.Mock).mockResolvedValue(dbApprovals);

      const result = await service.getApprovals('req-1');

      expect(result).toHaveLength(2);
      expect(result[0].approverWallet).toBe('0xwallet1');
      expect(result[0].approved).toBe(true);
      expect(result[0].signature).toBeUndefined(); // null maps to undefined
      expect(result[1].signature).toBe('0xsig');
      expect(mockPrisma.approval.findMany).toHaveBeenCalledWith({
        where: { requestId: 'req-1' },
      });
    });

    test('failure: returns empty array when no approvals exist', async () => {
      (mockPrisma.approval.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.getApprovals('req-no-approvals');

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getContributionScore
  // -------------------------------------------------------------------------

  describe('getContributionScore', () => {
    test('success: returns stored contribution score', async () => {
      (mockPrisma.contributionScore.findUnique as jest.Mock).mockResolvedValue({
        walletId: 'wallet-1',
        communityId: 'community-1',
        totalScore: 150,
        breakdown: { commits: 100, reviews: 50 },
      });

      const result = await service.getContributionScore('wallet-1', 'community-1');

      expect(result.total).toBe(150);
      expect((result.breakdown as any).commits).toBe(100);
    });

    test('failure: returns DEFAULT_CONTRIBUTION_SCORE when no score exists', async () => {
      (mockPrisma.contributionScore.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.getContributionScore('wallet-unknown', 'community-1');

      expect(result.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // updateContributionScore
  // -------------------------------------------------------------------------

  describe('updateContributionScore', () => {
    test('success: upserts a contribution score', async () => {
      const upserted = {
        walletId: 'wallet-1',
        communityId: 'community-1',
        totalScore: 200,
        breakdown: { commits: 200 },
      };
      (mockPrisma.contributionScore.upsert as jest.Mock).mockResolvedValue(upserted);

      const result = await service.updateContributionScore(
        'wallet-1',
        'community-1',
        200,
        { commits: 200 },
      );

      expect(result.totalScore).toBe(200);
      expect(mockPrisma.contributionScore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            walletId_communityId: { walletId: 'wallet-1', communityId: 'community-1' },
          },
          update: expect.objectContaining({ totalScore: 200 }),
          create: expect.objectContaining({ walletId: 'wallet-1', totalScore: 200 }),
        }),
      );
    });

    test('success: uses empty object for breakdown when not provided', async () => {
      (mockPrisma.contributionScore.upsert as jest.Mock).mockResolvedValue({
        walletId: 'w',
        communityId: 'c',
        totalScore: 50,
        breakdown: {},
      });

      await service.updateContributionScore('w', 'c', 50);

      expect(mockPrisma.contributionScore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ breakdown: {} }),
          create: expect.objectContaining({ breakdown: {} }),
        }),
      );
    });

    test('failure: propagates Prisma error', async () => {
      (mockPrisma.contributionScore.upsert as jest.Mock).mockRejectedValue(
        new Error('DB write error'),
      );

      await expect(
        service.updateContributionScore('w', 'c', 10),
      ).rejects.toThrow('DB write error');
    });
  });

  // -------------------------------------------------------------------------
  // evaluateGovernanceRule
  // -------------------------------------------------------------------------

  describe('evaluateGovernanceRule', () => {
    const roleContext = {
      membershipState: 'active' as const,
      assignments: [{ role: 'admin' as const, source: 'manual' as const, active: true }],
    };

    beforeEach(() => {
      (mockPrisma.contributionScore.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.approval.findMany as jest.Mock).mockResolvedValue([]);
    });

    test('success: evaluates a HasRole rule to true when wallet has the role', async () => {
      (mockPrisma.governanceRule.findUnique as jest.Mock).mockResolvedValue(makeDbRule());

      const result = await service.evaluateGovernanceRule({
        ruleId: 'rule-1',
        wallet: '0xadmin',
        communityId: 'community-1',
        roleContext,
      });

      // HasRole member — admin implies member via role hierarchy
      expect(result.allowed).toBe(true);
    });

    test('success: evaluates a HasRole rule to false when wallet lacks the role', async () => {
      (mockPrisma.governanceRule.findUnique as jest.Mock).mockResolvedValue(
        makeDbRule({ ast: { type: 'HasRole', role: 'admin' } }),
      );

      const noAdminContext = {
        membershipState: 'active' as const,
        assignments: [{ role: 'member' as const, source: 'auto' as const, active: true }],
      };

      const result = await service.evaluateGovernanceRule({
        ruleId: 'rule-1',
        wallet: '0xmember',
        communityId: 'community-1',
        roleContext: noAdminContext,
      });

      expect(result.allowed).toBe(false);
    });

    test('success: evaluates MinContributionScore rule against stored score', async () => {
      (mockPrisma.governanceRule.findUnique as jest.Mock).mockResolvedValue(
        makeDbRule({ ast: { type: 'MinContributionScore', score: 100 } }),
      );
      (mockPrisma.contributionScore.findUnique as jest.Mock).mockResolvedValue({
        walletId: '0xcontributor',
        communityId: 'community-1',
        totalScore: 150,
        breakdown: {},
      });

      const result = await service.evaluateGovernanceRule({
        ruleId: 'rule-1',
        wallet: '0xcontributor',
        communityId: 'community-1',
        roleContext,
      });

      expect(result.allowed).toBe(true);
    });

    test('success: fetches approvals when requestId is provided', async () => {
      (mockPrisma.governanceRule.findUnique as jest.Mock).mockResolvedValue(
        makeDbRule({
          ast: {
            type: 'RequiresApprovals',
            threshold: 1,
            approverRole: 'admin',
            requestId: 'req-1',
          },
        }),
      );
      (mockPrisma.approval.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'a-1',
          requestId: 'req-1',
          approverWallet: '0xadmin',
          approverRole: 'admin',
          approved: true,
          timestamp: now,
          signature: null,
        },
      ]);

      const result = await service.evaluateGovernanceRule({
        ruleId: 'rule-1',
        wallet: '0xrequester',
        communityId: 'community-1',
        roleContext,
        requestId: 'req-1',
      });

      expect(mockPrisma.approval.findMany).toHaveBeenCalledWith({
        where: { requestId: 'req-1' },
      });
      expect(result.allowed).toBe(true);
    });

    test('failure: throws when rule is not found', async () => {
      (mockPrisma.governanceRule.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.evaluateGovernanceRule({
          ruleId: 'nonexistent',
          wallet: '0xwallet',
          communityId: 'community-1',
          roleContext,
        }),
      ).rejects.toThrow('Governance rule not found: nonexistent');
    });

    test('failure: throws when rule is inactive', async () => {
      (mockPrisma.governanceRule.findUnique as jest.Mock).mockResolvedValue(
        makeDbRule({ active: false }),
      );

      await expect(
        service.evaluateGovernanceRule({
          ruleId: 'rule-1',
          wallet: '0xwallet',
          communityId: 'community-1',
          roleContext,
        }),
      ).rejects.toThrow('Governance rule is inactive: rule-1');
    });
  });
}); // end describe('GovernanceService')
