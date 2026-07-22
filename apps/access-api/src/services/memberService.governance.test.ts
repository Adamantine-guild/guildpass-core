import { PrismaClient } from '@prisma/client';
import type { RuleNode } from '@guildpass/governance-engine';
import { getMemberService } from './memberService';

// Audit logging is orthogonal to the governance decision under test; stub it so
// the tests stay focused (and don't reach into the audit hash-chain DB path).
jest.mock('./auditService', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));

const COMMUNITY = 'community-1';
const RESOURCE = 'vault';
const WALLET = '0x1111111111111111111111111111111111111111';

// A rule that only grants access to admins.
const ADMIN_ONLY_RULE: RuleNode = { type: 'HasRole', role: 'admin' };

interface MockState {
  governanceRules: Array<{ id: string; name: string; resource: string; ast: RuleNode; active: boolean }>;
  contributionScore: { totalScore: number; breakdown: unknown } | null;
}

function buildMockPrisma(state: MockState) {
  const wallet = { id: 'wallet-1', address: WALLET };
  const member = {
    id: 'member-1',
    communityId: COMMUNITY,
    walletId: 'wallet-1',
    roles: [], // no elevated roles → not an admin
    membership: { state: 'active', expiresAt: null },
  };

  return {
    // --- identity resolution ---
    linkedWallet: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    wallet: {
      findUnique: jest.fn().mockResolvedValue({ ...wallet, primaryLinkedWallets: [] }),
      findMany: jest.fn().mockResolvedValue([wallet]),
    },
    member: {
      findMany: jest.fn().mockResolvedValue([member]),
    },
    accessPolicy: {
      // PUBLIC base policy → base decision is ALLOW for everyone.
      findFirst: jest.fn().mockResolvedValue({
        id: 'policy-1',
        communityId: COMMUNITY,
        resource: RESOURCE,
        ruleType: 'PUBLIC',
        params: null,
      }),
    },
    accessOverride: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    governanceRule: {
      findMany: jest.fn().mockResolvedValue(state.governanceRules),
    },
    contributionScore: {
      findUnique: jest.fn().mockResolvedValue(state.contributionScore),
    },
    roleDefinition: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    delegatedGrant: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    outboxEvent: { create: jest.fn().mockResolvedValue({ id: 'outbox-1' }) },
    auditEvent: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    $transaction: jest.fn(),
  } as unknown as PrismaClient;
}

describe('checkAccess governance integration', () => {
  const input = { wallet: WALLET as `0x${string}`, communityId: COMMUNITY, resource: RESOURCE };

  it('flips an otherwise-ALLOW (PUBLIC) decision to DENY when a governance rule denies', async () => {
    const prisma = buildMockPrisma({
      governanceRules: [
        { id: 'rule-1', name: 'admins-only', resource: RESOURCE, ast: ADMIN_ONLY_RULE, active: true },
      ],
      contributionScore: null,
    });
    const memberService = getMemberService(prisma);

    const result = await memberService.checkAccess(input);

    expect(result.allowed).toBe(false);
    expect(result.code).toBe('DENY');
    // The governance denial is surfaced in the decision reasons.
    expect(result.reasons.some((r) => r.code === 'GOVERNANCE_DENY')).toBe(true);
  });

  it('keeps the PUBLIC decision ALLOW when the governance rule passes', async () => {
    const prisma = buildMockPrisma({
      // Rule requires an active membership, which this member has.
      governanceRules: [
        {
          id: 'rule-2',
          name: 'members',
          resource: RESOURCE,
          ast: { type: 'HasMembershipState', state: 'active' },
          active: true,
        },
      ],
      contributionScore: null,
    });
    const memberService = getMemberService(prisma);

    const result = await memberService.checkAccess(input);

    expect(result.allowed).toBe(true);
    expect(result.code).toBe('ALLOW');
    expect(result.reasons.some((r) => r.code === 'GOVERNANCE_ALLOW')).toBe(true);
  });

  it('is a no-op (identical to base) when no governance rules exist', async () => {
    const prisma = buildMockPrisma({ governanceRules: [], contributionScore: null });
    const memberService = getMemberService(prisma);

    const result = await memberService.checkAccess(input);

    expect(result.allowed).toBe(true);
    expect(result.code).toBe('ALLOW');
    // No governance reason codes are added when there are no rules.
    expect(result.reasons.some((r) => r.code?.startsWith('GOVERNANCE_'))).toBe(false);
    // Contribution score is not even queried when there are no rules.
    expect((prisma.contributionScore.findUnique as jest.Mock)).not.toHaveBeenCalled();
  });

  it('uses the contribution score for MinContributionScore rules', async () => {
    const prisma = buildMockPrisma({
      governanceRules: [
        {
          id: 'rule-3',
          name: 'min-score',
          resource: RESOURCE,
          ast: { type: 'MinContributionScore', score: 100 },
          active: true,
        },
      ],
      contributionScore: { totalScore: 40, breakdown: {} },
    });
    const memberService = getMemberService(prisma);

    const result = await memberService.checkAccess(input);

    expect(result.allowed).toBe(false);
    expect(result.code).toBe('DENY');
    expect(prisma.contributionScore.findUnique as jest.Mock).toHaveBeenCalled();
  });
});
