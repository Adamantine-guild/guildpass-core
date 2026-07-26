import { PrismaClient } from '@prisma/client';
import {
  createConstitutionalRuleSet,
  getActiveConstitutionalRuleSet,
  getConstitutionalRuleSetVersions,
  validateAndEvaluateMutation,
  ConstitutionalViolationError,
} from './constitutionalService';
import { ConstitutionalRule } from '@guildpass/constitutional-engine';

describe('Constitutional Service Tests', () => {
  let prisma: PrismaClient;
  const communityId = 'community-const-service-test';

  beforeAll(async () => {
    prisma = new PrismaClient();

    // Create community if not exists
    await prisma.community.upsert({
      where: { id: communityId },
      update: {},
      create: { id: communityId, name: 'Constitutional Test Community' },
    });
  });

  afterAll(async () => {
    // Clean up test data
    await prisma.auditEvent.deleteMany({ where: { communityId } });
    await prisma.outboxEvent.deleteMany({ where: { communityId } });
    await prisma.constitutionalRuleSet.deleteMany({ where: { communityId } });
    await prisma.community.deleteMany({ where: { id: communityId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany({ where: { communityId } });
    await prisma.outboxEvent.deleteMany({ where: { communityId } });
    await prisma.constitutionalRuleSet.deleteMany({ where: { communityId } });
  });

  test('should create version 1 rule set and set it active', async () => {
    const rules: ConstitutionalRule[] = [
      {
        id: 'cooldown-1',
        name: 'Role Cooldown Rule',
        targetAction: 'ROLE_ASSIGNMENT',
        precedence: 100,
        effect: 'DENY',
        type: 'COOLDOWN',
        params: { minIntervalSeconds: 3600 },
      },
    ];

    const ruleSet = await createConstitutionalRuleSet(prisma, {
      communityId,
      rules,
      createdBy: '0x1111111111111111111111111111111111111111',
      description: 'Initial Version 1',
    });

    expect(ruleSet.version).toBe(1);
    expect(ruleSet.active).toBe(true);
    expect(ruleSet.rules).toHaveLength(1);

    const active = await getActiveConstitutionalRuleSet(prisma, communityId);
    expect(active?.version).toBe(1);
  });

  test('should increment version to 2 and deactivate version 1 when new version is created', async () => {
    const rulesV1: ConstitutionalRule[] = [
      {
        id: 'cooldown-v1',
        name: 'V1 Rule',
        targetAction: 'ROLE_ASSIGNMENT',
        precedence: 50,
        effect: 'DENY',
        type: 'COOLDOWN',
        params: { minIntervalSeconds: 600 },
      },
    ];

    await createConstitutionalRuleSet(prisma, {
      communityId,
      rules: rulesV1,
      description: 'V1',
    });

    const rulesV2: ConstitutionalRule[] = [
      {
        id: 'cooldown-v2',
        name: 'V2 Rule',
        targetAction: 'ROLE_ASSIGNMENT',
        precedence: 100,
        effect: 'DENY',
        type: 'COOLDOWN',
        params: { minIntervalSeconds: 3600 },
      },
    ];

    const ruleSetV2 = await createConstitutionalRuleSet(prisma, {
      communityId,
      rules: rulesV2,
      description: 'V2 Update',
    });

    expect(ruleSetV2.version).toBe(2);
    expect(ruleSetV2.active).toBe(true);

    const active = await getActiveConstitutionalRuleSet(prisma, communityId);
    expect(active?.version).toBe(2);

    const versions = await getConstitutionalRuleSetVersions(prisma, communityId);
    expect(versions).toHaveLength(2);
    expect(versions.find((v) => v.version === 1)?.active).toBe(false);
    expect(versions.find((v) => v.version === 2)?.active).toBe(true);
  });

  test('should pass validateAndEvaluateMutation when no active rule set exists', async () => {
    const result = await prisma.$transaction(async (tx) => {
      return await validateAndEvaluateMutation(tx, {
        action: 'ROLE_ASSIGNMENT',
        communityId,
        actorWallet: '0xactor',
        targetWallet: '0xtarget',
      });
    });

    expect(result.allowed).toBe(true);
    expect(result.code).toBe('CONSTITUTIONAL_ALLOW');
  });

  test('should throw ConstitutionalViolationError when mutation violates active cooldown rule', async () => {
    // Create rule set requiring 1 hour cooldown
    await createConstitutionalRuleSet(prisma, {
      communityId,
      rules: [
        {
          id: 'cooldown-rule',
          name: '1-Hour Cooldown',
          targetAction: 'ROLE_ASSIGNMENT',
          precedence: 100,
          effect: 'DENY',
          type: 'COOLDOWN',
          params: { minIntervalSeconds: 3600 },
        },
      ],
    });

    const targetWallet = '0xtargetwallet123';

    // Simulate recent mutation audit event (5 minutes ago)
    await prisma.auditEvent.create({
      data: {
        eventType: 'OTHER',
        communityId,
        walletId: targetWallet,
        reasonCode: 'ROLE_ASSIGNED',
        createdAt: new Date(Date.now() - 300 * 1000), // 5 min ago
      },
    });

    // Attempt second mutation -> should fail cooldown
    await expect(
      prisma.$transaction(async (tx) => {
        return await validateAndEvaluateMutation(tx, {
          action: 'ROLE_ASSIGNMENT',
          communityId,
          actorWallet: '0xactor',
          targetWallet,
        });
      }),
    ).rejects.toThrow(ConstitutionalViolationError);
  });

  test('should pass validateAndEvaluateMutation when multi-admin approval requirement is satisfied', async () => {
    await createConstitutionalRuleSet(prisma, {
      communityId,
      rules: [
        {
          id: 'multiadmin-rule',
          name: '2 Admin Approval Required',
          targetAction: 'OVERRIDE_CREATE',
          precedence: 100,
          effect: 'REQUIRE_APPROVAL',
          type: 'MULTI_ADMIN_APPROVAL',
          params: { requiredApprovals: 2, approverRole: 'admin' },
        },
      ],
    });

    const result = await prisma.$transaction(async (tx) => {
      return await validateAndEvaluateMutation(tx, {
        action: 'OVERRIDE_CREATE',
        communityId,
        actorWallet: '0xactor',
        approvals: [
          { wallet: '0xadmin1', role: 'admin', timestamp: new Date() },
          { wallet: '0xadmin2', role: 'admin', timestamp: new Date() },
        ],
      });
    });

    expect(result.allowed).toBe(true);
  });
});
