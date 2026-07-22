import {
  ConstitutionalEngine,
  ConstitutionalRuleSet,
  MutationContext,
  validateRuleSet,
} from '../src';

describe('ConstitutionalEngine - Core Tests', () => {
  let engine: ConstitutionalEngine;

  beforeEach(() => {
    engine = new ConstitutionalEngine();
  });

  test('should validate a valid rule set', () => {
    const ruleSet: ConstitutionalRuleSet = {
      id: 'ruleset-1',
      communityId: 'dev-community',
      version: 1,
      rules: [
        {
          id: 'rule-cooldown-1',
          name: 'Role Mutation Cooldown',
          targetAction: 'ROLE_ASSIGNMENT',
          precedence: 100,
          effect: 'DENY',
          type: 'COOLDOWN',
          params: { minIntervalSeconds: 3600 },
        },
      ],
    };

    const res = validateRuleSet(ruleSet);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test('should reject invalid rule set schemas', () => {
    const invalidRuleSet = {
      communityId: '',
      version: 0,
      rules: [
        {
          id: '',
          targetAction: 'INVALID_ACTION',
          precedence: 'invalid',
          effect: 'UNKNOWN',
        },
      ],
    };

    const res = validateRuleSet(invalidRuleSet);
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  test('should allow mutation when no rules match', () => {
    const ruleSet: ConstitutionalRuleSet = {
      id: 'ruleset-1',
      communityId: 'dev-community',
      version: 1,
      rules: [
        {
          id: 'rule-1',
          name: 'Role Cooldown',
          targetAction: 'ROLE_ASSIGNMENT',
          precedence: 10,
          effect: 'DENY',
          type: 'COOLDOWN',
          params: { minIntervalSeconds: 3600 },
        },
      ],
    };

    const context: MutationContext = {
      action: 'POLICY_UPDATE',
      communityId: 'dev-community',
      actorWallet: '0x1111111111111111111111111111111111111111',
    };

    const result = engine.evaluate(ruleSet, context);
    expect(result.allowed).toBe(true);
    expect(result.code).toBe('CONSTITUTIONAL_ALLOW');
    expect(result.reasons[0].code).toBe('NO_MATCHING_RULES');
  });

  test('should order matching rules by precedence descending', () => {
    const ruleSet: ConstitutionalRuleSet = {
      id: 'ruleset-1',
      communityId: 'dev-community',
      version: 1,
      rules: [
        {
          id: 'rule-low-priority',
          name: 'Low Precedence Rule',
          targetAction: 'ROLE_ASSIGNMENT',
          precedence: 10,
          effect: 'DENY',
          type: 'COOLDOWN',
          params: { minIntervalSeconds: 10 },
        },
        {
          id: 'rule-high-priority',
          name: 'High Precedence Rule',
          targetAction: 'ROLE_ASSIGNMENT',
          precedence: 200,
          effect: 'DENY',
          type: 'COOLDOWN',
          params: { minIntervalSeconds: 3600 },
        },
      ],
    };

    const context: MutationContext = {
      action: 'ROLE_ASSIGNMENT',
      communityId: 'dev-community',
      actorWallet: '0x1111111111111111111111111111111111111111',
      previousMutationTimestamp: new Date(Date.now() - 50 * 1000), // 50s ago (passes low 10s, fails high 3600s)
    };

    const result = engine.evaluate(ruleSet, context);
    expect(result.allowed).toBe(false);
    expect(result.traces[0].ruleId).toBe('rule-high-priority'); // Evaluated first due to precedence 200
    expect(result.traces[1].ruleId).toBe('rule-low-priority');
  });

  test('should format trace text correctly', () => {
    const ruleSet: ConstitutionalRuleSet = {
      id: 'ruleset-1',
      communityId: 'dev-community',
      version: 1,
      rules: [
        {
          id: 'rule-1',
          name: 'Role Cooldown Guard',
          targetAction: 'ROLE_ASSIGNMENT',
          precedence: 100,
          effect: 'DENY',
          type: 'COOLDOWN',
          params: { minIntervalSeconds: 3600 },
        },
      ],
    };

    const context: MutationContext = {
      action: 'ROLE_ASSIGNMENT',
      communityId: 'dev-community',
      actorWallet: '0x1111111111111111111111111111111111111111',
      previousMutationTimestamp: new Date(Date.now() - 1000),
    };

    const result = engine.evaluate(ruleSet, context);
    const traceString = engine.formatTrace(result);
    expect(traceString).toContain('Constitutional Evaluation Result: CONSTITUTIONAL_DENY');
    expect(traceString).toContain('Role Cooldown Guard');
  });
});
