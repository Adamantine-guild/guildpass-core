/**
 * Constitutional Rule Engine - Evaluator
 *
 * Evaluates governance rules against a resolved context.
 * Produces transparent, human-readable explanation traces.
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
 * Evaluate a governance rule against a context
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
 * Recursively evaluate a rule node
 */
function evaluateNode(node: RuleNode, context: GovernanceContext): EvaluationTrace {
  // Evaluate primitive predicates
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

  // Evaluate boolean combinators
  if (isAndNode(node)) {
    return evaluateAnd(node, context);
  }

  if (isOrNode(node)) {
    return evaluateOr(node, context);
  }

  if (isNotNode(node)) {
    return evaluateNot(node, context);
  }

  if (isNOfMNode(node)) {
    return evaluateNOfM(node, context);
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
function evaluateAnd(node: any, context: GovernanceContext): EvaluationTrace {
  const children: EvaluationTrace[] = [];
  let allTrue = true;

  for (const childRule of node.rules) {
    const childTrace = evaluateNode(childRule, context);
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
function evaluateOr(node: any, context: GovernanceContext): EvaluationTrace {
  const children: EvaluationTrace[] = [];
  let anyTrue = false;

  for (const childRule of node.rules) {
    const childTrace = evaluateNode(childRule, context);
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
function evaluateNot(node: any, context: GovernanceContext): EvaluationTrace {
  const childTrace = evaluateNode(node.rule, context);
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
function evaluateNOfM(node: any, context: GovernanceContext): EvaluationTrace {
  const children: EvaluationTrace[] = [];
  let passedCount = 0;

  for (const childRule of node.rules) {
    const childTrace = evaluateNode(childRule, context);
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
