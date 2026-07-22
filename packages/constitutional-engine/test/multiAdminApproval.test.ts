import {
  ConstitutionalEngine,
  ConstitutionalRuleSet,
  MutationContext,
} from '../src';

describe('ConstitutionalEngine - Multi-Admin Approval Rule Tests', () => {
  let engine: ConstitutionalEngine;

  const ruleSet: ConstitutionalRuleSet = {
    id: 'ruleset-multiadmin',
    communityId: 'dev-community',
    version: 1,
    rules: [
      {
        id: 'rule-multiadmin-2of3',
        name: 'Multi-Admin Approval (2 Admins Required)',
        targetAction: 'ROLE_ASSIGNMENT',
        precedence: 100,
        effect: 'REQUIRE_APPROVAL',
        type: 'MULTI_ADMIN_APPROVAL',
        params: {
          requiredApprovals: 2,
          approverRole: 'admin',
          approvalMaxAgeSeconds: 86400, // 24h max age
        },
      },
    ],
  };

  beforeEach(() => {
    engine = new ConstitutionalEngine();
  });

  test('should return APPROVAL_REQUIRED when insufficient admin approvals provided', () => {
    const context: MutationContext = {
      action: 'ROLE_ASSIGNMENT',
      communityId: 'dev-community',
      actorWallet: '0x1111111111111111111111111111111111111111',
      approvals: [
        {
          wallet: '0xadmin1',
          role: 'admin',
          timestamp: new Date(),
        },
      ],
    };

    const result = engine.evaluate(ruleSet, context);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('APPROVAL_REQUIRED');
    expect(result.traces[0].passed).toBe(false);
    expect(result.traces[0].metadata?.validCount).toBe(1);
    expect(result.traces[0].metadata?.requiredApprovals).toBe(2);
  });

  test('should pass when required threshold of distinct admin approvals is met', () => {
    const now = new Date();
    const context: MutationContext = {
      action: 'ROLE_ASSIGNMENT',
      communityId: 'dev-community',
      actorWallet: '0x1111111111111111111111111111111111111111',
      approvals: [
        {
          wallet: '0xadmin1',
          role: 'admin',
          timestamp: new Date(now.getTime() - 1000),
        },
        {
          wallet: '0xadmin2',
          role: 'admin',
          timestamp: new Date(now.getTime() - 2000),
        },
      ],
    };

    const result = engine.evaluate(ruleSet, context, now);
    expect(result.allowed).toBe(true);
    expect(result.code).toBe('CONSTITUTIONAL_ALLOW');
    expect(result.traces[0].passed).toBe(true);
    expect(result.traces[0].metadata?.validCount).toBe(2);
  });

  test('should ignore duplicate approvals from the same wallet', () => {
    const now = new Date();
    const context: MutationContext = {
      action: 'ROLE_ASSIGNMENT',
      communityId: 'dev-community',
      actorWallet: '0x1111111111111111111111111111111111111111',
      approvals: [
        {
          wallet: '0xadmin1',
          role: 'admin',
          timestamp: new Date(now.getTime() - 1000),
        },
        {
          wallet: '0xADMIN1', // Same wallet (case insensitive)
          role: 'admin',
          timestamp: new Date(now.getTime() - 500),
        },
      ],
    };

    const result = engine.evaluate(ruleSet, context, now);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('APPROVAL_REQUIRED');
    expect(result.traces[0].metadata?.validCount).toBe(1);
  });

  test('should ignore approvals from non-admin roles', () => {
    const now = new Date();
    const context: MutationContext = {
      action: 'ROLE_ASSIGNMENT',
      communityId: 'dev-community',
      actorWallet: '0x1111111111111111111111111111111111111111',
      approvals: [
        {
          wallet: '0xadmin1',
          role: 'admin',
          timestamp: new Date(now.getTime() - 1000),
        },
        {
          wallet: '0xuser1',
          role: 'member', // Not an admin
          timestamp: new Date(now.getTime() - 500),
        },
      ],
    };

    const result = engine.evaluate(ruleSet, context, now);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('APPROVAL_REQUIRED');
  });

  test('should ignore expired approvals', () => {
    const now = new Date();
    const oldTimestamp = new Date(now.getTime() - 100000 * 1000); // Exceeds 86400s max age

    const context: MutationContext = {
      action: 'ROLE_ASSIGNMENT',
      communityId: 'dev-community',
      actorWallet: '0x1111111111111111111111111111111111111111',
      approvals: [
        {
          wallet: '0xadmin1',
          role: 'admin',
          timestamp: now,
        },
        {
          wallet: '0xadmin2',
          role: 'admin',
          timestamp: oldTimestamp, // Expired
        },
      ],
    };

    const result = engine.evaluate(ruleSet, context, now);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('APPROVAL_REQUIRED');
    expect(result.traces[0].metadata?.validCount).toBe(1);
  });
});
