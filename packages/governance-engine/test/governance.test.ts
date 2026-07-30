/**
 * Constitutional Rule Engine - Tests
 */

import {
  RuleNode,
  HasRoleNode,
  MinContributionScoreNode,
  HasMembershipStateNode,
  RequiresApprovalsNode,
  AndNode,
  OrNode,
  NotNode,
  NOfMNode,
  ApprovalRecord,
} from '../src/ast';
import {
  validateRuleAST,
  parseAndValidateRuleJSON,
  computeComplexity,
  RESOURCE_LIMITS,
} from '../src/validator';
import {
  GovernanceContext,
  createGovernanceContext,
  DEFAULT_CONTRIBUTION_SCORE,
} from '../src/context';
import {
  evaluateRule,
  evaluateRuleWithBudget,
  formatTrace,
  DEFAULT_TIMEOUT_MS,
} from '../src/evaluator';
import type { RoleContext } from '@guildpass/shared-types';

describe('AST Validation', () => {
  test('validates HasRole node', () => {
    const node: HasRoleNode = {
      type: 'HasRole',
      role: 'admin',
    };

    const result = validateRuleAST(node);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('rejects HasRole with invalid role', () => {
    const node = {
      type: 'HasRole',
      role: 'superadmin', // invalid role
    };

    const result = validateRuleAST(node);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('rejects HasRole with unexpected properties', () => {
    const node = {
      type: 'HasRole',
      role: 'admin',
      malicious: 'eval("code")', // injection attempt
    };

    const result = validateRuleAST(node);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Unexpected properties'))).toBe(true);
  });

  test('validates MinContributionScore node', () => {
    const node: MinContributionScoreNode = {
      type: 'MinContributionScore',
      score: 100,
    };

    const result = validateRuleAST(node);
    expect(result.valid).toBe(true);
  });

  test('rejects MinContributionScore with negative score', () => {
    const node = {
      type: 'MinContributionScore',
      score: -10,
    };

    const result = validateRuleAST(node);
    expect(result.valid).toBe(false);
  });

  test('validates HasMembershipState node', () => {
    const node: HasMembershipStateNode = {
      type: 'HasMembershipState',
      state: 'active',
    };

    const result = validateRuleAST(node);
    expect(result.valid).toBe(true);
  });

  test('validates RequiresApprovals node', () => {
    const node: RequiresApprovalsNode = {
      type: 'RequiresApprovals',
      threshold: 2,
      approverRole: 'admin',
    };

    const result = validateRuleAST(node);
    expect(result.valid).toBe(true);
  });

  test('validates AND node', () => {
    const node: AndNode = {
      type: 'AND',
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'HasMembershipState', state: 'active' },
      ],
    };

    const result = validateRuleAST(node);
    expect(result.valid).toBe(true);
  });

  test('validates nested combinators', () => {
    const node: AndNode = {
      type: 'AND',
      rules: [
        {
          type: 'OR',
          rules: [
            { type: 'HasRole', role: 'admin' },
            { type: 'HasRole', role: 'contributor' },
          ],
        },
        { type: 'HasMembershipState', state: 'active' },
      ],
    };

    const result = validateRuleAST(node);
    expect(result.valid).toBe(true);
  });

  test('rejects deeply nested rules exceeding max depth', () => {
    // Create a deeply nested structure (> 10 levels)
    let node: RuleNode = { type: 'HasRole', role: 'admin' };
    
    for (let i = 0; i < 12; i++) {
      node = {
        type: 'AND',
        rules: [node],
      };
    }

    const result = validateRuleAST(node);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('exceeds maximum depth'))).toBe(true);
  });

  test('validates N_OF_M node', () => {
    const node: NOfMNode = {
      type: 'N_OF_M',
      n: 2,
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'HasRole', role: 'contributor' },
        { type: 'MinContributionScore', score: 50 },
      ],
    };

    const result = validateRuleAST(node);
    expect(result.valid).toBe(true);
  });

  test('rejects N_OF_M where n > number of rules', () => {
    const node = {
      type: 'N_OF_M',
      n: 5,
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'HasRole', role: 'contributor' },
      ],
    };

    const result = validateRuleAST(node);
    expect(result.valid).toBe(false);
  });

  test('resource limits are exported with expected values', () => {
    expect(RESOURCE_LIMITS.maxDepth).toBe(10);
    expect(RESOURCE_LIMITS.maxChildren).toBe(50);
    expect(RESOURCE_LIMITS.maxComplexity).toBe(64);
  });
});

describe('Complexity Scoring', () => {
  test('primitive predicate has complexity 1', () => {
    expect(computeComplexity({ type: 'HasRole', role: 'admin' })).toBe(1);
    expect(computeComplexity({ type: 'MinContributionScore', score: 100 })).toBe(1);
    expect(computeComplexity({ type: 'HasMembershipState', state: 'active' })).toBe(1);
  });

  test('RequiresApprovals has complexity 2', () => {
    expect(computeComplexity({ type: 'RequiresApprovals', threshold: 2, approverRole: 'admin' })).toBe(2);
  });

  test('AND with 2 primitives has complexity 4', () => {
    const node: AndNode = {
      type: 'AND',
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'MinContributionScore', score: 100 },
      ],
    };
    expect(computeComplexity(node)).toBe(4);
  });

  test('OR with 3 primitives has complexity 5', () => {
    const node: OrNode = {
      type: 'OR',
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'HasRole', role: 'contributor' },
        { type: 'HasMembershipState', state: 'active' },
      ],
    };
    expect(computeComplexity(node)).toBe(5);
  });

  test('NOT has complexity 3 (2 for NOT + 1 for child)', () => {
    const node: NotNode = {
      type: 'NOT',
      rule: { type: 'HasRole', role: 'admin' },
    };
    expect(computeComplexity(node)).toBe(3);
  });

  test('N_OF_M with 3 primitives has complexity 6', () => {
    const node: NOfMNode = {
      type: 'N_OF_M',
      n: 2,
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'HasRole', role: 'contributor' },
        { type: 'MinContributionScore', score: 50 },
      ],
    };
    expect(computeComplexity(node)).toBe(6);
  });

  test('complex nested rule produces expected complexity', () => {
    const node: OrNode = {
      type: 'OR',
      rules: [
        { type: 'HasRole', role: 'admin' },
        {
          type: 'AND',
          rules: [
            { type: 'HasRole', role: 'contributor' },
            { type: 'MinContributionScore', score: 100 },
          ],
        },
        {
          type: 'N_OF_M',
          n: 2,
          rules: [
            { type: 'HasRole', role: 'contributor' },
            { type: 'MinContributionScore', score: 50 },
            { type: 'HasMembershipState', state: 'active' },
          ],
        },
      ],
    };
    // OR(2) + admin(1) + AND(2) + contributor(1) + score100(1) + N_OF_M(3) + contributor(1) + score50(1) + active(1) = 13
    expect(computeComplexity(node)).toBe(13);
  });

  test('rejects AST with complexity exceeding MAX_COMPLEXITY', () => {
    // Build a tree that is structurally valid (depth ≤10, children ≤50)
    // but whose total complexity exceeds 64.
    // N_OF_M{ 2 AND children, each having 30 HasRole primitives }
    // Complexity = 3 (N_OF_M) + (2+30) + (2+30) = 67 > 64
    const node = {
      type: 'N_OF_M',
      n: 1,
      rules: [
        { type: 'AND', rules: Array.from({ length: 30 }, () => ({ type: 'HasRole', role: 'admin' as const })) },
        { type: 'AND', rules: Array.from({ length: 30 }, () => ({ type: 'HasRole', role: 'admin' as const })) },
      ],
    };

    const result = validateRuleAST(node);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('exceeds maximum');
    expect(result.errors[0]).toContain('64');
  });

  test('accepts AST with complexity at exactly MAX_COMPLEXITY', () => {
    // Build a tree with complexity = 64 (max allowed)
    // OR{ AND(30 HasRole), AND(28 HasRole) }
    // Complexity = 2 (OR) + (2+30) + (2+28) = 64
    const node = {
      type: 'OR',
      rules: [
        { type: 'AND', rules: Array.from({ length: 30 }, () => ({ type: 'HasRole', role: 'admin' as const })) },
        { type: 'AND', rules: Array.from({ length: 28 }, () => ({ type: 'HasRole', role: 'admin' as const })) },
      ],
    };

    const validation = validateRuleAST(node);
    expect(validation.valid).toBe(true);
    // Verify complexity is at the limit
    expect(computeComplexity(node as any as RuleNode)).toBe(RESOURCE_LIMITS.maxComplexity);
  });
});

describe('Rule Evaluation', () => {
  const baseRoleContext: RoleContext = {
    assignments: [],
    membershipState: 'active',
  };

  test('evaluates HasRole - user has role', () => {
    const rule: HasRoleNode = {
      type: 'HasRole',
      role: 'admin',
    };

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      {
        assignments: [{ role: 'admin', source: 'manual', active: true }],
        membershipState: 'active',
      },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(true);
    expect(result.trace.ruleType).toBe('HasRole');
    expect(result.trace.evaluated).toBe(true);
  });

  test('evaluates HasRole - user lacks role', () => {
    const rule: HasRoleNode = {
      type: 'HasRole',
      role: 'admin',
    };

    const context = createGovernanceContext(
      '0xbob',
      'community-1',
      {
        assignments: [{ role: 'contributor', source: 'manual', active: true }],
        membershipState: 'active',
      },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(false);
    expect(result.trace.evaluated).toBe(false);
  });

  test('evaluates MinContributionScore - meets threshold', () => {
    const rule: MinContributionScoreNode = {
      type: 'MinContributionScore',
      score: 100,
    };

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      baseRoleContext,
      { total: 150, breakdown: { commits: 100, reviews: 50 } },
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(true);
    expect(result.trace.metadata?.userScore).toBe(150);
  });

  test('evaluates MinContributionScore - below threshold', () => {
    const rule: MinContributionScoreNode = {
      type: 'MinContributionScore',
      score: 100,
    };

    const context = createGovernanceContext(
      '0xbob',
      'community-1',
      baseRoleContext,
      { total: 50 },
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(false);
    expect(result.trace.metadata?.userScore).toBe(50);
  });

  test('evaluates HasMembershipState', () => {
    const rule: HasMembershipStateNode = {
      type: 'HasMembershipState',
      state: 'active',
    };

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      { assignments: [], membershipState: 'active' },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(true);
  });

  test('evaluates RequiresApprovals - sufficient approvals', () => {
    const rule: RequiresApprovalsNode = {
      type: 'RequiresApprovals',
      threshold: 2,
      approverRole: 'admin',
    };

    const approvals: ApprovalRecord[] = [
      {
        id: '1',
        requestId: 'req-1',
        approverWallet: '0xadmin1',
        approverRole: 'admin',
        approved: true,
        timestamp: new Date().toISOString(),
      },
      {
        id: '2',
        requestId: 'req-1',
        approverWallet: '0xadmin2',
        approverRole: 'admin',
        approved: true,
        timestamp: new Date().toISOString(),
      },
    ];

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      baseRoleContext,
      DEFAULT_CONTRIBUTION_SCORE,
      approvals,
      'req-1',
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(true);
    expect(result.trace.metadata?.approvalCount).toBe(2);
  });

  test('evaluates RequiresApprovals - insufficient approvals', () => {
    const rule: RequiresApprovalsNode = {
      type: 'RequiresApprovals',
      threshold: 3,
      approverRole: 'admin',
    };

    const approvals: ApprovalRecord[] = [
      {
        id: '1',
        requestId: 'req-1',
        approverWallet: '0xadmin1',
        approverRole: 'admin',
        approved: true,
        timestamp: new Date().toISOString(),
      },
    ];

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      baseRoleContext,
      DEFAULT_CONTRIBUTION_SCORE,
      approvals,
      'req-1',
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(false);
    expect(result.trace.metadata?.approvalCount).toBe(1);
  });

  test('evaluates AND - all conditions pass', () => {
    const rule: AndNode = {
      type: 'AND',
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'HasMembershipState', state: 'active' },
      ],
    };

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      {
        assignments: [{ role: 'admin', source: 'manual', active: true }],
        membershipState: 'active',
      },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(true);
    expect(result.trace.children).toHaveLength(2);
  });

  test('evaluates AND - one condition fails', () => {
    const rule: AndNode = {
      type: 'AND',
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'MinContributionScore', score: 100 },
      ],
    };

    const context = createGovernanceContext(
      '0xbob',
      'community-1',
      {
        assignments: [{ role: 'admin', source: 'manual', active: true }],
        membershipState: 'active',
      },
      { total: 50 }, // Below threshold
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(false);
  });

  test('evaluates OR - one condition passes', () => {
    const rule: OrNode = {
      type: 'OR',
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'HasRole', role: 'contributor' },
      ],
    };

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      {
        assignments: [{ role: 'contributor', source: 'manual', active: true }],
        membershipState: 'active',
      },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(true);
  });

  test('evaluates OR - all conditions fail', () => {
    const rule: OrNode = {
      type: 'OR',
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'MinContributionScore', score: 100 },
      ],
    };

    const context = createGovernanceContext(
      '0xbob',
      'community-1',
      {
        assignments: [],
        membershipState: 'active',
      },
      { total: 10 },
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(false);
  });

  test('evaluates NOT - negates true to false', () => {
    const rule: NotNode = {
      type: 'NOT',
      rule: { type: 'HasRole', role: 'admin' },
    };

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      {
        assignments: [{ role: 'admin', source: 'manual', active: true }],
        membershipState: 'active',
      },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(false);
  });

  test('evaluates NOT - negates false to true', () => {
    const rule: NotNode = {
      type: 'NOT',
      rule: { type: 'HasRole', role: 'admin' },
    };

    const context = createGovernanceContext(
      '0xbob',
      'community-1',
      {
        assignments: [],
        membershipState: 'active',
      },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(true);
  });

  test('evaluates N_OF_M - exactly N pass', () => {
    const rule: NOfMNode = {
      type: 'N_OF_M',
      n: 2,
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'HasRole', role: 'contributor' },
        { type: 'MinContributionScore', score: 1000 },
      ],
    };

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      {
        assignments: [
          { role: 'admin', source: 'manual', active: true },
          { role: 'contributor', source: 'manual', active: true },
        ],
        membershipState: 'active',
      },
      { total: 50 }, // Doesn't meet contribution score
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(true);
    expect(result.trace.metadata?.passed).toBe(2);
  });

  test('evaluates N_OF_M - less than N pass', () => {
    const rule: NOfMNode = {
      type: 'N_OF_M',
      n: 2,
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'MinContributionScore', score: 1000 },
        { type: 'HasMembershipState', state: 'suspended' },
      ],
    };

    const context = createGovernanceContext(
      '0xbob',
      'community-1',
      {
        assignments: [],
        membershipState: 'active',
      },
      { total: 50 },
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(false);
  });
});

describe('Complex Rule Scenarios', () => {
  test('evaluates complex governance rule: Admin OR (Contributor AND Score >= 100)', () => {
    const rule: OrNode = {
      type: 'OR',
      rules: [
        { type: 'HasRole', role: 'admin' },
        {
          type: 'AND',
          rules: [
            { type: 'HasRole', role: 'contributor' },
            { type: 'MinContributionScore', score: 100 },
          ],
        },
      ],
    };

    // Test as admin
    const adminContext = createGovernanceContext(
      '0xadmin',
      'community-1',
      {
        assignments: [{ role: 'admin', source: 'manual', active: true }],
        membershipState: 'active',
      },
      { total: 0 },
    );

    const adminResult = evaluateRule(rule, adminContext);
    expect(adminResult.allowed).toBe(true);

    // Test as contributor with sufficient score
    const contributorContext = createGovernanceContext(
      '0xcontributor',
      'community-1',
      {
        assignments: [{ role: 'contributor', source: 'manual', active: true }],
        membershipState: 'active',
      },
      { total: 150 },
    );

    const contributorResult = evaluateRule(rule, contributorContext);
    expect(contributorResult.allowed).toBe(true);

    // Test as contributor with insufficient score
    const lowScoreContext = createGovernanceContext(
      '0xlowscore',
      'community-1',
      {
        assignments: [{ role: 'contributor', source: 'manual', active: true }],
        membershipState: 'active',
      },
      { total: 50 },
    );

    const lowScoreResult = evaluateRule(rule, lowScoreContext);
    expect(lowScoreResult.allowed).toBe(false);
  });

  test('evaluates multi-party approval rule: 2-of-3 Admins', () => {
    const rule: RequiresApprovalsNode = {
      type: 'RequiresApprovals',
      threshold: 2,
      approverRole: 'admin',
      requestId: 'proposal-123',
    };

    const twoApprovals: ApprovalRecord[] = [
      {
        id: '1',
        requestId: 'proposal-123',
        approverWallet: '0xadmin1',
        approverRole: 'admin',
        approved: true,
        timestamp: new Date().toISOString(),
      },
      {
        id: '2',
        requestId: 'proposal-123',
        approverWallet: '0xadmin2',
        approverRole: 'admin',
        approved: true,
        timestamp: new Date().toISOString(),
      },
    ];

    const context = createGovernanceContext(
      '0xproposer',
      'community-1',
      { assignments: [], membershipState: 'active' },
      DEFAULT_CONTRIBUTION_SCORE,
      twoApprovals,
      'proposal-123',
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(true);
    expect(result.trace.details).toContain('2 of 2 required approvals');
  });
});

describe('JSON Parsing and Validation', () => {
  test('parses and validates correct JSON rule', () => {
    const json = JSON.stringify({
      type: 'AND',
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'HasMembershipState', state: 'active' },
      ],
    });

    const { ast, validation } = parseAndValidateRuleJSON(json);
    expect(validation.valid).toBe(true);
    expect(ast).not.toBeNull();
    expect(ast?.type).toBe('AND');
  });

  test('rejects malformed JSON', () => {
    const json = '{ invalid json }';

    const { ast, validation } = parseAndValidateRuleJSON(json);
    expect(validation.valid).toBe(false);
    expect(ast).toBeNull();
    expect(validation.errors[0]).toContain('JSON parse error');
  });

  test('rejects JSON with injection attempt', () => {
    const json = '{"type":"HasRole","role":"admin","__proto__":{"malicious":true}}';

    const { ast, validation } = parseAndValidateRuleJSON(json);
    expect(validation.valid).toBe(false);
  });
});

describe('Trace Formatting', () => {
  test('formats simple trace', () => {
    const rule: HasRoleNode = {
      type: 'HasRole',
      role: 'admin',
    };

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      {
        assignments: [{ role: 'admin', source: 'manual', active: true }],
        membershipState: 'active',
      },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const result = evaluateRule(rule, context);
    const formatted = formatTrace(result.trace);
    
    expect(formatted).toContain('✓');
    expect(formatted).toContain('HasRole');
    expect(formatted).toContain('User has role "admin"');
  });

  test('formats nested trace', () => {
    const rule: AndNode = {
      type: 'AND',
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'MinContributionScore', score: 100 },
      ],
    };

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      {
        assignments: [{ role: 'admin', source: 'manual', active: true }],
        membershipState: 'active',
      },
      { total: 150 },
    );

    const result = evaluateRule(rule, context);
    const formatted = formatTrace(result.trace);
    
    expect(formatted).toContain('AND');
    expect(formatted).toContain('HasRole');
    expect(formatted).toContain('MinContributionScore');
  });
});

describe('Budget-Aware Evaluation', () => {
  const baseRoleContext: RoleContext = {
    assignments: [],
    membershipState: 'active',
  };

  test('evaluateRuleWithBudget passes simple rule well within budget', () => {
    const rule: HasRoleNode = { type: 'HasRole', role: 'admin' };
    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      {
        assignments: [{ role: 'admin', source: 'manual', active: true }],
        membershipState: 'active',
      },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const result = evaluateRuleWithBudget(rule, context);
    expect(result.allowed).toBe(true);
    expect(result.trace.ruleType).toBe('HasRole');
  });

  test('evaluateRuleWithBudget returns TIMEOUT with negative budget', () => {
    // A negative deadline triggers immediate timeout on the first yield point.
    const rule: HasRoleNode = { type: 'HasRole', role: 'admin' };
    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      {
        assignments: [{ role: 'admin', source: 'manual', active: true }],
        membershipState: 'active',
      },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const result = evaluateRuleWithBudget(rule, context, { timeoutMs: -1 });
    expect(result.allowed).toBe(false);
    expect(result.trace.ruleType).toBe('TIMEOUT');
    expect(result.trace.details).toContain('exceeded time budget');
  });

  test('evaluateRuleWithBudget returns TIMEOUT for deep rules with tiny budget', () => {
    // Build a deep-ish rule and give it a 1-microsecond budget.
    // This reliably triggers timeout even on fast hardware.
    let deep: RuleNode = { type: 'HasRole', role: 'admin' };
    for (let i = 0; i < 8; i++) {
      deep = { type: 'AND', rules: [deep] };
    }

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      baseRoleContext,
      DEFAULT_CONTRIBUTION_SCORE,
    );

    // Use a negative deadline: force immediate timeout on first check
    const result = evaluateRuleWithBudget(deep, context, { timeoutMs: -1 });
    expect(result.allowed).toBe(false);
    expect(result.trace.ruleType).toBe('TIMEOUT');
  });

  test('evaluateRuleWithBudget correctly allows passing rules with default budget', () => {
    const rule: AndNode = {
      type: 'AND',
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'HasMembershipState', state: 'active' },
      ],
    };

    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      {
        assignments: [{ role: 'admin', source: 'manual', active: true }],
        membershipState: 'active',
      },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const result = evaluateRuleWithBudget(rule, context);
    expect(result.allowed).toBe(true);
    expect(result.trace.ruleType).toBe('AND');
    expect(result.trace.children).toHaveLength(2);
  });

  test('DEFAULT_TIMEOUT_MS is exported as 5', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(5);
  });

  test('unbounded evaluateRule still works after budget changes', () => {
    const rule: HasRoleNode = { type: 'HasRole', role: 'admin' };
    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      {
        assignments: [{ role: 'admin', source: 'manual', active: true }],
        membershipState: 'active',
      },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const result = evaluateRule(rule, context);
    expect(result.allowed).toBe(true);
    expect(result.trace.ruleType).toBe('HasRole');
  });

  test('most complex valid AST evaluates well within 5ms budget', () => {
    // Build the most complex AST the validator would accept:
    // OR( AND(30 HasRole), AND(28 HasRole) ) → complexity = 64
    const node = {
      type: 'OR' as const,
      rules: [
        { type: 'AND' as const, rules: Array.from({ length: 30 }, () => ({ type: 'HasRole' as const, role: 'admin' as const })) },
        { type: 'AND' as const, rules: Array.from({ length: 28 }, () => ({ type: 'HasRole' as const, role: 'admin' as const })) },
      ],
    };

    // Validate it passes
    const validation = validateRuleAST(node);
    expect(validation.valid).toBe(true);

    // Evaluate it with the default budget — must complete
    const context = createGovernanceContext(
      '0xalice',
      'community-1',
      {
        assignments: [{ role: 'admin', source: 'manual', active: true }],
        membershipState: 'active',
      },
      DEFAULT_CONTRIBUTION_SCORE,
    );

    const start = Date.now();
    const result = evaluateRuleWithBudget(node, context);
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(true);
    expect(result.trace.ruleType).toBe('OR');
    expect(result.trace.children).toHaveLength(2);
    // Must complete well within the 5ms budget (typically < 1ms)
    expect(elapsed).toBeLessThan(3000);
  });
});
