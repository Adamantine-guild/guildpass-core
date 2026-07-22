import type { RoleContext } from '@guildpass/shared-types';
import type { EvaluationContext } from '@guildpass/policy-engine';
import type { RuleNode } from '@guildpass/governance-engine';
import {
  GovernanceRuleProvider,
  DEFAULT_GOVERNANCE_PRIORITY,
  type ActiveGovernanceRule,
} from './governanceRuleProvider';

const basePolicy = {
  id: 'policy-1',
  communityId: 'community-1',
  resource: 'docs',
  ruleType: 'PUBLIC',
  params: undefined,
};

function makeContext(roleContext: RoleContext): EvaluationContext {
  return {
    policy: basePolicy as EvaluationContext['policy'],
    roleContext,
    effectiveRoles: roleContext.assignments
      .filter((a) => a.active)
      .map((a) => a.role),
  };
}

function rule(name: string, ast: RuleNode): ActiveGovernanceRule {
  return { id: `rule-${name}`, name, resource: 'docs', ast };
}

const adminContext: RoleContext = {
  assignments: [{ role: 'admin', source: 'manual', active: true }],
  membershipState: 'active',
  wallet: '0xabc',
  communityId: 'community-1',
  resource: 'docs',
};

const memberContext: RoleContext = {
  assignments: [],
  membershipState: 'active',
  wallet: '0xdef',
  communityId: 'community-1',
  resource: 'docs',
};

describe('GovernanceRuleProvider', () => {
  it('has a priority in the governance band (500-999)', () => {
    const provider = new GovernanceRuleProvider({
      rules: [],
      wallet: '0xabc',
      communityId: 'community-1',
    });
    expect(provider.priority).toBe(DEFAULT_GOVERNANCE_PRIORITY);
    expect(provider.priority).toBeGreaterThanOrEqual(500);
    expect(provider.priority).toBeLessThanOrEqual(999);
  });

  it('respects a custom priority', () => {
    const provider = new GovernanceRuleProvider({
      rules: [],
      wallet: '0xabc',
      communityId: 'community-1',
      priority: 750,
    });
    expect(provider.priority).toBe(750);
  });

  it('ABSTAINs when there are no active rules', () => {
    const provider = new GovernanceRuleProvider({
      rules: [],
      wallet: '0xabc',
      communityId: 'community-1',
    });
    const result = provider.evaluate(makeContext(adminContext));
    expect(result.result).toBe('ABSTAIN');
    expect(result.code).toBe('GOVERNANCE_NO_RULES');
  });

  it('ALLOWs when the sole rule passes (HasRole admin)', () => {
    const provider = new GovernanceRuleProvider({
      rules: [rule('admins', { type: 'HasRole', role: 'admin' })],
      wallet: '0xabc',
      communityId: 'community-1',
    });
    const result = provider.evaluate(makeContext(adminContext));
    expect(result.result).toBe('ALLOW');
    expect(result.code).toBe('GOVERNANCE_ALLOW');
  });

  it('DENYs when the sole rule fails (HasRole admin, non-admin caller)', () => {
    const provider = new GovernanceRuleProvider({
      rules: [rule('admins', { type: 'HasRole', role: 'admin' })],
      wallet: '0xdef',
      communityId: 'community-1',
    });
    const result = provider.evaluate(makeContext(memberContext));
    expect(result.result).toBe('DENY');
    expect(result.code).toBe('GOVERNANCE_DENY');
    expect(result.explanation).toContain('admins');
  });

  it('evaluates MinContributionScore against the seeded score', () => {
    const ast: RuleNode = { type: 'MinContributionScore', score: 100 };

    const denied = new GovernanceRuleProvider({
      rules: [rule('score', ast)],
      wallet: '0xdef',
      communityId: 'community-1',
      contributionScore: { total: 50 },
    }).evaluate(makeContext(memberContext));
    expect(denied.result).toBe('DENY');

    const allowed = new GovernanceRuleProvider({
      rules: [rule('score', ast)],
      wallet: '0xdef',
      communityId: 'community-1',
      contributionScore: { total: 150 },
    }).evaluate(makeContext(memberContext));
    expect(allowed.result).toBe('ALLOW');
  });

  it('applies AND semantics across multiple rules (any failure => DENY)', () => {
    const provider = new GovernanceRuleProvider({
      rules: [
        rule('active-member', { type: 'HasMembershipState', state: 'active' }),
        rule('needs-admin', { type: 'HasRole', role: 'admin' }),
      ],
      wallet: '0xdef',
      communityId: 'community-1',
    });
    // member is active (passes rule 1) but not admin (fails rule 2) => DENY
    const result = provider.evaluate(makeContext(memberContext));
    expect(result.result).toBe('DENY');
    expect(result.explanation).toContain('needs-admin');
    expect(result.explanation).not.toContain('active-member');
  });

  it('ALLOWs only when every rule passes', () => {
    const provider = new GovernanceRuleProvider({
      rules: [
        rule('active-member', { type: 'HasMembershipState', state: 'active' }),
        rule('is-admin', { type: 'HasRole', role: 'admin' }),
      ],
      wallet: '0xabc',
      communityId: 'community-1',
    });
    const result = provider.evaluate(makeContext(adminContext));
    expect(result.result).toBe('ALLOW');
  });
});
