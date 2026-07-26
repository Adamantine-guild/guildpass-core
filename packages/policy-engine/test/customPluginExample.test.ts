import {
  AccessPolicy,
  RoleContext,
  Role,
  AccessDecision,
  DecisionReason,
} from '@guildpass/shared-types';
import {
  PolicyRulePlugin,
  PolicyRulePluginRegistry,
  evaluate,
  createDefaultRegistry,
} from '../src';

class CustomExampleRule implements PolicyRulePlugin {
  readonly type = 'CUSTOM_EXAMPLE_RULE';

  evaluate(policy: AccessPolicy, context: RoleContext, effectiveRoles: Role[]): AccessDecision {
    const reasons: DecisionReason[] = [
      {
        code: `MEMBERSHIP_${context.membershipState.toUpperCase()}`,
        message: `Membership is ${context.membershipState}`,
      },
      {
        code: 'CUSTOM_RULE_APPLIED',
        message: 'Custom example rule applied (always allows)',
      },
    ];

    return {
      allowed: true,
      code: 'ALLOW',
      reasons,
      effectiveRoles,
      membershipState: context.membershipState,
    };
  }

  explain(policy: AccessPolicy, context: RoleContext, effectiveRoles: Role[]): string {
    const decision = this.evaluate(policy, context, effectiveRoles);
    const status = decision.allowed ? 'ALLOWED' : 'DENIED';
    const paramsString = policy.params ? ` params=${JSON.stringify(policy.params)}` : '';
    const lines = [
      `${status} for ruleType=${this.type}${paramsString}`,
      `roles=[${effectiveRoles.join(', ')}]`,
      ...decision.reasons.map(r => `- ${r.code}: ${r.message}`),
    ];
    return lines.join('\n');
  }
}

describe('Custom Policy Plugins', () => {
  it('should allow registering and evaluating a custom plugin', () => {
    // Create a new registry
    const registry = new PolicyRulePluginRegistry();
    // Register custom plugin
    registry.register(new CustomExampleRule());
    // Check that plugin is registered
    expect(registry.has('CUSTOM_EXAMPLE_RULE')).toBe(true);
    expect(registry.listTypes()).toContain('CUSTOM_EXAMPLE_RULE');

    // Create policy using the custom rule
    const policy: AccessPolicy = {
      id: 'test-policy',
      communityId: 'test-community',
      resource: 'test-resource',
      ruleType: 'CUSTOM_EXAMPLE_RULE',
    };

    const context: RoleContext = {
      wallet: '0x123',
      membershipState: 'active',
      assignments: [],
    };

    // Evaluate using our custom registry
    const decision = evaluate(policy, context, { registry });
    expect(decision.allowed).toBe(true);
    expect(decision.reasons.some(r => r.code === 'CUSTOM_RULE_APPLIED')).toBe(true);
  });

  it('should throw an error when registering duplicate plugin type', () => {
    const registry = new PolicyRulePluginRegistry();
    registry.register(new CustomExampleRule());
    // Attempting to register again should throw
    expect(() => {
      registry.register(new CustomExampleRule());
    }).toThrow('Plugin for rule type \'CUSTOM_EXAMPLE_RULE\' is already registered');
  });

  it('should use the default registry if none is provided', () => {
    // Default registry should already have all four built-in rules
    const defaultRegistry = createDefaultRegistry();
    expect(defaultRegistry.has('PUBLIC')).toBe(true);
    expect(defaultRegistry.has('MEMBERS_ONLY')).toBe(true);
    expect(defaultRegistry.has('ADMINS_ONLY')).toBe(true);
    expect(defaultRegistry.has('CONTRIBUTORS_OR_ADMINS')).toBe(true);
  });
});
