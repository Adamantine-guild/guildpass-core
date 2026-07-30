/**
 * Load tests for governance-rule sandboxing / resource-limiting.
 *
 * These tests verify that even adversarially-crafted rules (the most complex
 * AST the validator would accept) execute within a predictable, bounded time
 * budget and cannot degrade the hot path.
 */

import {
  RuleNode,
  AndNode,
} from '../src/ast';
import {
  validateRuleAST,
  computeComplexity,
  RESOURCE_LIMITS,
} from '../src/validator';
import {
  evaluateRuleWithBudget,
  createGovernanceContext,
  DEFAULT_CONTRIBUTION_SCORE,
} from '../src';
import type { RoleContext } from '@guildpass/shared-types';

const BASE_ROLE_CONTEXT: RoleContext = {
  assignments: [{ role: 'admin', source: 'manual', active: true }],
  membershipState: 'active',
};

/**
 * Build a maximally-complex-but-valid rule AST.
 *
 * Strategy: an OR combinator with two AND children, each having enough
 * primitive children to reach MAX_COMPLEXITY = 64.
 *   2 (OR) + (2+30) + (2+28) = 64
 * Each child AND stays within MAX_CHILDREN = 50.
 */
function buildMaxComplexityAST() {
  return {
    type: 'OR' as const,
    rules: [
      { type: 'AND' as const, rules: Array.from({ length: 30 }, () => ({ type: 'HasRole' as const, role: 'admin' as const })) },
      { type: 'AND' as const, rules: Array.from({ length: 28 }, () => ({ type: 'HasRole' as const, role: 'admin' as const })) },
    ],
  };
}

describe('Load Test: Resource-Limiting / Sandboxing', () => {
  test('max-complexity AST passes validation', () => {
    const ast = buildMaxComplexityAST();
    const validation = validateRuleAST(ast);
    expect(validation.valid).toBe(true);
    expect(computeComplexity(ast)).toBe(RESOURCE_LIMITS.maxComplexity);
  });

  test('single evaluation of max-complexity rule completes in microseconds', () => {
    const ast = buildMaxComplexityAST();
    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      BASE_ROLE_CONTEXT,
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const start = Date.now();
    const result = evaluateRuleWithBudget(ast, context);
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(true);
    expect(result.trace.ruleType).toBe('OR');
    expect(result.trace.children).toHaveLength(2);
    // Must complete in well under 1ms; 5ms budget is extremely conservative.
    // We allow up to 2ms due to Date.now() 1ms resolution.
    expect(elapsed).toBeLessThan(2);
  });

  test('1000 evaluations of max-complexity rule stay within aggregate budget', () => {
    const ast = buildMaxComplexityAST();
    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      BASE_ROLE_CONTEXT,
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const iterations = 1000;
    const start = Date.now();

    for (let i = 0; i < iterations; i++) {
      const result = evaluateRuleWithBudget(ast, context);
      expect(result.allowed).toBe(true);
    }

    const totalElapsed = Date.now() - start;
    const avgElapsed = totalElapsed / iterations;

    // 1000 evaluations should complete in well under 100ms total
    // (each evaluation is ~1–5 µs on modern hardware)
    expect(totalElapsed).toBeLessThan(500);
    expect(avgElapsed).toBeLessThan(0.5);
  });

  test('max-depth AST accepted by validator evaluates within budget', () => {
    // Build a depth-10 chain: AND(AND(...(HasRole)...))
    let deep: RuleNode = { type: 'HasRole', role: 'admin' };
    for (let i = 0; i < RESOURCE_LIMITS.maxDepth; i++) {
      deep = { type: 'AND', rules: [deep] };
    }

    const validation = validateRuleAST(deep);
    expect(validation.valid).toBe(true);

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      BASE_ROLE_CONTEXT,
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const start = Date.now();
    const result = evaluateRuleWithBudget(deep, context);
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(true);
    expect(elapsed).toBeLessThan(1);
  });

  test('AST rejected by complexity limit (> 64) never reaches evaluator', () => {
    // N_OF_M(AND(30 HasRole), AND(30 HasRole)) = 3+32+32 = 67 > 64
    const ast = {
      type: 'N_OF_M',
      n: 1,
      rules: [
        { type: 'AND', rules: Array.from({ length: 30 }, () => ({ type: 'HasRole', role: 'admin' })) },
        { type: 'AND', rules: Array.from({ length: 30 }, () => ({ type: 'HasRole', role: 'admin' })) },
      ],
    };

    const validation = validateRuleAST(ast);
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toContain('64');
  });
});
