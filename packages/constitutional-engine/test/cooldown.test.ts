import {
  ConstitutionalEngine,
  ConstitutionalRuleSet,
  MutationContext,
} from '../src';

describe('ConstitutionalEngine - Cooldown Rule Tests', () => {
  let engine: ConstitutionalEngine;

  const ruleSet: ConstitutionalRuleSet = {
    id: 'ruleset-cooldown',
    communityId: 'dev-community',
    version: 1,
    rules: [
      {
        id: 'rule-cooldown-24h',
        name: '24 Hour Mutation Cooldown',
        targetAction: 'ROLE_ASSIGNMENT',
        precedence: 100,
        effect: 'DENY',
        type: 'COOLDOWN',
        params: { minIntervalSeconds: 86400 }, // 24 hours
      },
    ],
  };

  beforeEach(() => {
    engine = new ConstitutionalEngine();
  });

  test('should pass when no previous mutation exists', () => {
    const context: MutationContext = {
      action: 'ROLE_ASSIGNMENT',
      communityId: 'dev-community',
      actorWallet: '0x1111111111111111111111111111111111111111',
      targetWallet: '0x2222222222222222222222222222222222222222',
      previousMutationTimestamp: null,
    };

    const result = engine.evaluate(ruleSet, context);
    expect(result.allowed).toBe(true);
    expect(result.code).toBe('CONSTITUTIONAL_ALLOW');
    expect(result.traces[0].passed).toBe(true);
  });

  test('should deny when mutation occurs before cooldown period elapses', () => {
    const now = new Date();
    const tenHoursAgo = new Date(now.getTime() - 10 * 3600 * 1000); // 10 hours ago (< 24 hours)

    const context: MutationContext = {
      action: 'ROLE_ASSIGNMENT',
      communityId: 'dev-community',
      actorWallet: '0x1111111111111111111111111111111111111111',
      targetWallet: '0x2222222222222222222222222222222222222222',
      previousMutationTimestamp: tenHoursAgo,
    };

    const result = engine.evaluate(ruleSet, context, now);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('CONSTITUTIONAL_DENY');
    expect(result.traces[0].passed).toBe(false);
    expect(result.traces[0].metadata?.elapsedSeconds).toBe(36000);
    expect(result.traces[0].metadata?.remainingSeconds).toBe(50400);
  });

  test('should pass when cooldown period has fully elapsed', () => {
    const now = new Date();
    const thirtyHoursAgo = new Date(now.getTime() - 30 * 3600 * 1000); // 30 hours ago (> 24 hours)

    const context: MutationContext = {
      action: 'ROLE_ASSIGNMENT',
      communityId: 'dev-community',
      actorWallet: '0x1111111111111111111111111111111111111111',
      targetWallet: '0x2222222222222222222222222222222222222222',
      previousMutationTimestamp: thirtyHoursAgo,
    };

    const result = engine.evaluate(ruleSet, context, now);
    expect(result.allowed).toBe(true);
    expect(result.code).toBe('CONSTITUTIONAL_ALLOW');
    expect(result.traces[0].passed).toBe(true);
  });
});
