/**
 * Constitutional Rule Engine - Evaluator
 *
 * Evaluates governance rules against a resolved context.
 * Produces transparent, human-readable explanation traces.
 *
 * Resource limiting:
 * - All evaluation goes through evaluateNode(), which checks a wall-clock
 *   deadline at each node entry (yield point). If exceeded, it returns a
 *   TIMEOUT trace immediately.
 * - The evaluator is a pure, synchronous tree-walk interpreter. Since the AST
 *   is bounded by validateRuleAST() (depth ≤10, complexity ≤64), evaluation
 *   with a 5 ms budget is extremely conservative — a complexity-64 rule
 *   completes in microseconds on modern hardware.
 * - For maximum isolation, the entire evaluation is synchronous and uses no
 *   shared mutable state; each evaluateRuleWithBudget() call is fully
 *   self-contained.
 */

import {
  RuleNode,
  isHasRoleNode,
  isMinContributionScoreNode,
  isHasMembershipStateNode,
  isRequiresApprovalsNode,
  isAndNode,
  isOrNode,
  isNotNode,
  isNOfMNode,
} from './ast';
import { GovernanceContext } from './context';

/**
 * Evaluation Result
 * Contains the decision and a detailed explanation trace
 */
export interface EvaluationResult {
  allowed: boolean;
  trace: EvaluationTrace;
}

/**
 * Evaluation Trace
 * Step-by-step explanation of rule evaluation
 */
export interface EvaluationTrace {
  ruleType: string;
  evaluated: boolean;
  details: string;
  children?: EvaluationTrace[];
  metadata?: Record<string, any>;
}

/**
 * Options for budget-aware rule evaluation
 */
export interface EvaluationOptions {
  /** Hard wall-clock timeout in milliseconds (default: 5) */
  timeoutMs?: number;
}

/**
 * Default evaluation timeout in milliseconds.
 * 5 ms is >1000× the typical evaluation time for a complexity-64 rule,
 * providing a generous safety net while keeping any single evaluation
 * well under an API request's total latency budget.
 */
export const DEFAULT_TIMEOUT_MS = 5;

/**
 * Evaluate a governance rule against a context with a hard time budget.
 *
 * This is the sandboxed entry point used by GovernanceRuleProvider.
 * If evaluation does not complete within `options.timeoutMs`, the result
 * is a DENY with a TIMEOUT trace — ensuring that a maliciously crafted
 * rule (within the validator's bounds) cannot degrade the hot path.
 */
export function evaluateRuleWithBudget(
  rule: RuleNode,
  context: GovernanceContext,
  options?: EvaluationOptions,
): EvaluationResult {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const trace = evaluateNode(rule, context, deadline);
  return { allowed: trace.evaluated, trace };
}

/**
 * Evaluate a governance rule against a context (unbounded).
 *
 * Kept for backward compatibility. For production use with the
 * policy-engine RuleProvider, prefer evaluateRuleWithBudget().
 */
export function evaluateRule(
  rule: RuleNode,
  context: GovernanceContext,
): EvaluationResult {
  const trace = evaluateNode(rule, context);
  return {
    allowed: trace.evaluated,
    trace,
  };
}

/**
 * Recursively evaluate a rule node.
 * Checks the wall-clock deadline at each yield point.
 */
function evaluateNode(
  node: RuleNode,
  context: GovernanceContext,
  deadline?: number,
): EvaluationTrace {
  // Yield point: check time budget before each node evaluation
  if (deadline !== undefined && Date.now() > deadline) {
    return {
      ruleType: 'TIMEOUT',
      evaluated: false,
      details: `Rule evaluation exceeded time budget`,
    };
  }

  if (isHasRoleNode(node)) {
    return evaluateHasRole(node, context);
  }

  if (isMinContributionScoreNode(node)) {
    return evaluateMinContributionScore(node, context);
  }

  if (isHasMembershipStateNode(node)) {
    return evaluateHasMembershipState(node, context);
  }

  if (isRequiresApprovalsNode(node)) {
    return evaluateRequiresApprovals(node, context);
  }

  if (isAndNode(node)) {
    return evaluateAnd(node, context, deadline);
  }

  if (isOrNode(node)) {
    return evaluateOr(node, context, deadline);
  }

  if (isNotNode(node)) {
    return evaluateNot(node, context, deadline);
  }

  if (isNOfMNode(node)) {
    return evaluateNOfM(node, context, deadline);
  }

  // Unknown node type (should never happen if validator is used)
  return {
    ruleType: 'UNKNOWN',
    evaluated: false,
    details: `Unknown rule type: ${(node as any).type}`,
  };
}

/**
 * Evaluate HasRole predicate
 */
function evaluateHasRole(node: any, context: GovernanceContext): EvaluationTrace {
  const hasRole = context.roles.includes(node.role);

  return {
    ruleType: 'HasRole',
    evaluated: hasRole,
    details: hasRole
      ? `User has role "${node.role}"`
      : `User does not have role "${node.role}" (has: ${context.roles.join(', ') || 'none'})`,
    metadata: {
      requiredRole: node.role,
      userRoles: context.roles,
    },
  };
}

/**
 * Evaluate MinContributionScore predicate
 */
function evaluateMinContributionScore(node: any, context: GovernanceContext): EvaluationTrace {
  const userScore = context.contributionScore.total;
  const meetsThreshold = userScore >= node.score;

  return {
    ruleType: 'MinContributionScore',
    evaluated: meetsThreshold,
    details: meetsThreshold
      ? `User contribution score ${userScore} meets minimum ${node.score}`
      : `User contribution score ${userScore} is below minimum ${node.score}`,
    metadata: {
      requiredScore: node.score,
      userScore,
      breakdown: context.contributionScore.breakdown,
    },
  };
}

/**
 * Evaluate HasMembershipState predicate
 */
function evaluateHasMembershipState(node: any, context: GovernanceContext): EvaluationTrace {
  const hasState = context.membershipState === node.state;

  return {
    ruleType: 'HasMembershipState',
    evaluated: hasState,
    details: hasState
      ? `User membership state is "${node.state}"`
      : `User membership state is "${context.membershipState}", expected "${node.state}"`,
    metadata: {
      requiredState: node.state,
      userState: context.membershipState,
    },
  };
}

/**
 * Evaluate RequiresApprovals predicate
 */
function evaluateRequiresApprovals(node: any, context: GovernanceContext): EvaluationTrace {
  // Filter approvals by approver role
  const relevantApprovals = context.approvals.filter(
    (approval) =>
      approval.approverRole === node.approverRole &&
      approval.approved === true &&
      (!node.requestId || approval.requestId === node.requestId),
  );

  const approvalCount = relevantApprovals.length;
  const meetsThreshold = approvalCount >= node.threshold;

  const approverWallets = relevantApprovals.map((a) => a.approverWallet);

  return {
    ruleType: 'RequiresApprovals',
    evaluated: meetsThreshold,
    details: meetsThreshold
      ? `Has ${approvalCount} of ${node.threshold} required approvals from role "${node.approverRole}"`
      : `Has only ${approvalCount} of ${node.threshold} required approvals from role "${node.approverRole}"`,
    metadata: {
      requiredThreshold: node.threshold,
      requiredRole: node.approverRole,
      approvalCount,
      approverWallets,
      requestId: node.requestId || context.requestId,
    },
  };
}

/**
 * Evaluate AND combinator
 */
function evaluateAnd(
  node: any,
  context: GovernanceContext,
  deadline?: number,
): EvaluationTrace {
  const children: EvaluationTrace[] = [];
  let allTrue = true;

  for (const childRule of node.rules) {
    const childTrace = evaluateNode(childRule, context, deadline);
    children.push(childTrace);
    
    if (!childTrace.evaluated) {
      allTrue = false;
      // Continue evaluating all children for complete trace
    }
  }

  const passedCount = children.filter((c) => c.evaluated).length;
  const totalCount = children.length;

  return {
    ruleType: 'AND',
    evaluated: allTrue,
    details: allTrue
      ? `All ${totalCount} conditions passed`
      : `Only ${passedCount} of ${totalCount} conditions passed (all required)`,
    children,
  };
}

/**
 * Evaluate OR combinator
 */
function evaluateOr(
  node: any,
  context: GovernanceContext,
  deadline?: number,
): EvaluationTrace {
  const children: EvaluationTrace[] = [];
  let anyTrue = false;

  for (const childRule of node.rules) {
    const childTrace = evaluateNode(childRule, context, deadline);
    children.push(childTrace);
    
    if (childTrace.evaluated) {
      anyTrue = true;
      // Continue evaluating all children for complete trace
    }
  }

  const passedCount = children.filter((c) => c.evaluated).length;
  const totalCount = children.length;

  return {
    ruleType: 'OR',
    evaluated: anyTrue,
    details: anyTrue
      ? `${passedCount} of ${totalCount} conditions passed (at least 1 required)`
      : `None of ${totalCount} conditions passed (at least 1 required)`,
    children,
  };
}

/**
 * Evaluate NOT combinator
 */
function evaluateNot(
  node: any,
  context: GovernanceContext,
  deadline?: number,
): EvaluationTrace {
  const childTrace = evaluateNode(node.rule, context, deadline);
  const negated = !childTrace.evaluated;

  return {
    ruleType: 'NOT',
    evaluated: negated,
    details: negated
      ? 'Condition is false (as required)'
      : 'Condition is true (expected false)',
    children: [childTrace],
  };
}

/**
 * Evaluate N_OF_M combinator
 */
function evaluateNOfM(
  node: any,
  context: GovernanceContext,
  deadline?: number,
): EvaluationTrace {
  const children: EvaluationTrace[] = [];
  let passedCount = 0;

  for (const childRule of node.rules) {
    const childTrace = evaluateNode(childRule, context, deadline);
    children.push(childTrace);
    
    if (childTrace.evaluated) {
      passedCount++;
    }
  }

  const meetsThreshold = passedCount >= node.n;
  const totalCount = children.length;

  return {
    ruleType: 'N_OF_M',
    evaluated: meetsThreshold,
    details: meetsThreshold
      ? `${passedCount} of ${totalCount} conditions passed (${node.n} required)`
      : `Only ${passedCount} of ${totalCount} conditions passed (${node.n} required)`,
    children,
    metadata: {
      n: node.n,
      m: totalCount,
      passed: passedCount,
    },
  };
}

/**
 * Format evaluation trace as human-readable text
 */
export function formatTrace(trace: EvaluationTrace, indent: number = 0): string {
  const indentStr = '  '.repeat(indent);
  const status = trace.evaluated ? '✓' : '✗';
  const lines: string[] = [`${indentStr}${status} ${trace.ruleType}: ${trace.details}`];

  if (trace.metadata) {
    const metadataStr = JSON.stringify(trace.metadata, null, 2)
      .split('\n')
      .map((line) => `${indentStr}  ${line}`)
      .join('\n');
    lines.push(metadataStr);
  }

  if (trace.children) {
    for (const child of trace.children) {
      lines.push(formatTrace(child, indent + 1));
    }
  }

  return lines.join('\n');
}

/**
 * Get summary of evaluation result
 */
export function getSummary(result: EvaluationResult): string {
  const status = result.allowed ? 'ALLOWED' : 'DENIED';
  return `${status}: ${result.trace.details}`;
}
