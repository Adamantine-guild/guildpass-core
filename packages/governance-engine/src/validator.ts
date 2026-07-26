/**
 * Constitutional Rule Engine - AST Validator
 *
 * Validates rule ASTs to ensure they are well-formed and safe to evaluate.
 * Prevents injection of executable code or malformed structures.
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
import { Role, MembershipState } from '@guildpass/shared-types';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Valid role values
 */
const VALID_ROLES: Role[] = ['admin', 'member', 'contributor'];

/**
 * Valid membership state values
 */
const VALID_MEMBERSHIP_STATES: MembershipState[] = [
  'invited',
  'active',
  'expired',
  'suspended',
];

/**
 * Maximum depth of nested rules to prevent stack overflow
 */
const MAX_DEPTH = 10;

/**
 * Maximum number of child rules in a combinator
 */
const MAX_CHILDREN = 50;

/**
 * Validate a complete rule AST
 */
export function validateRuleAST(node: unknown, depth: number = 0): ValidationResult {
  const errors: string[] = [];

  // Check depth limit
  if (depth > MAX_DEPTH) {
    errors.push(`Rule nesting exceeds maximum depth of ${MAX_DEPTH}`);
    return { valid: false, errors };
  }

  // Ensure node is an object
  if (typeof node !== 'object' || node === null) {
    errors.push('Rule node must be a non-null object');
    return { valid: false, errors };
  }

  // Ensure node has a type property
  if (!('type' in node) || typeof (node as any).type !== 'string') {
    errors.push('Rule node must have a string "type" property');
    return { valid: false, errors };
  }

  const ruleNode = node as RuleNode;

  // Validate based on node type
  switch (ruleNode.type) {
    case 'HasRole':
      return validateHasRoleNode(ruleNode as any);
    
    case 'MinContributionScore':
      return validateMinContributionScoreNode(ruleNode as any);
    
    case 'HasMembershipState':
      return validateHasMembershipStateNode(ruleNode as any);
    
    case 'RequiresApprovals':
      return validateRequiresApprovalsNode(ruleNode as any);
    
    case 'AND':
      return validateAndNode(ruleNode as any, depth);
    
    case 'OR':
      return validateOrNode(ruleNode as any, depth);
    
    case 'NOT':
      return validateNotNode(ruleNode as any, depth);
    
    case 'N_OF_M':
      return validateNOfMNode(ruleNode as any, depth);
    
    default:
      errors.push(`Unknown rule type: ${(ruleNode as any).type}`);
      return { valid: false, errors };
  }
}

/**
 * Validate HasRole node
 */
function validateHasRoleNode(node: any): ValidationResult {
  const errors: string[] = [];

  if (!node.role || typeof node.role !== 'string') {
    errors.push('HasRole node must have a string "role" property');
  } else if (!VALID_ROLES.includes(node.role as Role)) {
    errors.push(`Invalid role: ${node.role}. Must be one of: ${VALID_ROLES.join(', ')}`);
  }

  // Check for unexpected properties (injection attempt)
  const allowedKeys = ['type', 'role'];
  const unexpectedKeys = Object.keys(node).filter(k => !allowedKeys.includes(k));
  if (unexpectedKeys.length > 0) {
    errors.push(`Unexpected properties in HasRole node: ${unexpectedKeys.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate MinContributionScore node
 */
function validateMinContributionScoreNode(node: any): ValidationResult {
  const errors: string[] = [];

  if (typeof node.score !== 'number') {
    errors.push('MinContributionScore node must have a numeric "score" property');
  } else if (node.score < 0) {
    errors.push('MinContributionScore score must be non-negative');
  } else if (!Number.isFinite(node.score)) {
    errors.push('MinContributionScore score must be finite');
  }

  // Check for unexpected properties
  const allowedKeys = ['type', 'score'];
  const unexpectedKeys = Object.keys(node).filter(k => !allowedKeys.includes(k));
  if (unexpectedKeys.length > 0) {
    errors.push(`Unexpected properties in MinContributionScore node: ${unexpectedKeys.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate HasMembershipState node
 */
function validateHasMembershipStateNode(node: any): ValidationResult {
  const errors: string[] = [];

  if (!node.state || typeof node.state !== 'string') {
    errors.push('HasMembershipState node must have a string "state" property');
  } else if (!VALID_MEMBERSHIP_STATES.includes(node.state as MembershipState)) {
    errors.push(
      `Invalid membership state: ${node.state}. Must be one of: ${VALID_MEMBERSHIP_STATES.join(', ')}`
    );
  }

  // Check for unexpected properties
  const allowedKeys = ['type', 'state'];
  const unexpectedKeys = Object.keys(node).filter(k => !allowedKeys.includes(k));
  if (unexpectedKeys.length > 0) {
    errors.push(`Unexpected properties in HasMembershipState node: ${unexpectedKeys.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate RequiresApprovals node
 */
function validateRequiresApprovalsNode(node: any): ValidationResult {
  const errors: string[] = [];

  if (typeof node.threshold !== 'number') {
    errors.push('RequiresApprovals node must have a numeric "threshold" property');
  } else if (node.threshold < 1) {
    errors.push('RequiresApprovals threshold must be at least 1');
  } else if (!Number.isInteger(node.threshold)) {
    errors.push('RequiresApprovals threshold must be an integer');
  }

  if (!node.approverRole || typeof node.approverRole !== 'string') {
    errors.push('RequiresApprovals node must have a string "approverRole" property');
  } else if (!VALID_ROLES.includes(node.approverRole as Role)) {
    errors.push(
      `Invalid approver role: ${node.approverRole}. Must be one of: ${VALID_ROLES.join(', ')}`
    );
  }

  if (node.requestId !== undefined && typeof node.requestId !== 'string') {
    errors.push('RequiresApprovals requestId must be a string if provided');
  }

  // Check for unexpected properties
  const allowedKeys = ['type', 'threshold', 'approverRole', 'requestId'];
  const unexpectedKeys = Object.keys(node).filter(k => !allowedKeys.includes(k));
  if (unexpectedKeys.length > 0) {
    errors.push(`Unexpected properties in RequiresApprovals node: ${unexpectedKeys.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate AND node
 */
function validateAndNode(node: any, depth: number): ValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(node.rules)) {
    errors.push('AND node must have a "rules" array property');
    return { valid: false, errors };
  }

  if (node.rules.length === 0) {
    errors.push('AND node must have at least one child rule');
  }

  if (node.rules.length > MAX_CHILDREN) {
    errors.push(`AND node exceeds maximum of ${MAX_CHILDREN} children`);
  }

  // Recursively validate children
  for (let i = 0; i < node.rules.length; i++) {
    const childResult = validateRuleAST(node.rules[i], depth + 1);
    if (!childResult.valid) {
      errors.push(`AND child[${i}]: ${childResult.errors.join(', ')}`);
    }
  }

  // Check for unexpected properties
  const allowedKeys = ['type', 'rules'];
  const unexpectedKeys = Object.keys(node).filter(k => !allowedKeys.includes(k));
  if (unexpectedKeys.length > 0) {
    errors.push(`Unexpected properties in AND node: ${unexpectedKeys.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate OR node
 */
function validateOrNode(node: any, depth: number): ValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(node.rules)) {
    errors.push('OR node must have a "rules" array property');
    return { valid: false, errors };
  }

  if (node.rules.length === 0) {
    errors.push('OR node must have at least one child rule');
  }

  if (node.rules.length > MAX_CHILDREN) {
    errors.push(`OR node exceeds maximum of ${MAX_CHILDREN} children`);
  }

  // Recursively validate children
  for (let i = 0; i < node.rules.length; i++) {
    const childResult = validateRuleAST(node.rules[i], depth + 1);
    if (!childResult.valid) {
      errors.push(`OR child[${i}]: ${childResult.errors.join(', ')}`);
    }
  }

  // Check for unexpected properties
  const allowedKeys = ['type', 'rules'];
  const unexpectedKeys = Object.keys(node).filter(k => !allowedKeys.includes(k));
  if (unexpectedKeys.length > 0) {
    errors.push(`Unexpected properties in OR node: ${unexpectedKeys.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate NOT node
 */
function validateNotNode(node: any, depth: number): ValidationResult {
  const errors: string[] = [];

  if (!node.rule || typeof node.rule !== 'object') {
    errors.push('NOT node must have a "rule" object property');
    return { valid: false, errors };
  }

  // Recursively validate child
  const childResult = validateRuleAST(node.rule, depth + 1);
  if (!childResult.valid) {
    errors.push(`NOT child: ${childResult.errors.join(', ')}`);
  }

  // Check for unexpected properties
  const allowedKeys = ['type', 'rule'];
  const unexpectedKeys = Object.keys(node).filter(k => !allowedKeys.includes(k));
  if (unexpectedKeys.length > 0) {
    errors.push(`Unexpected properties in NOT node: ${unexpectedKeys.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate N_OF_M node
 */
function validateNOfMNode(node: any, depth: number): ValidationResult {
  const errors: string[] = [];

  if (typeof node.n !== 'number') {
    errors.push('N_OF_M node must have a numeric "n" property');
  } else if (node.n < 1) {
    errors.push('N_OF_M n must be at least 1');
  } else if (!Number.isInteger(node.n)) {
    errors.push('N_OF_M n must be an integer');
  }

  if (!Array.isArray(node.rules)) {
    errors.push('N_OF_M node must have a "rules" array property');
    return { valid: false, errors };
  }

  if (node.rules.length === 0) {
    errors.push('N_OF_M node must have at least one child rule');
  }

  if (node.rules.length > MAX_CHILDREN) {
    errors.push(`N_OF_M node exceeds maximum of ${MAX_CHILDREN} children`);
  }

  if (typeof node.n === 'number' && node.n > node.rules.length) {
    errors.push(`N_OF_M n (${node.n}) cannot exceed number of rules (${node.rules.length})`);
  }

  // Recursively validate children
  for (let i = 0; i < node.rules.length; i++) {
    const childResult = validateRuleAST(node.rules[i], depth + 1);
    if (!childResult.valid) {
      errors.push(`N_OF_M child[${i}]: ${childResult.errors.join(', ')}`);
    }
  }

  // Check for unexpected properties
  const allowedKeys = ['type', 'n', 'rules'];
  const unexpectedKeys = Object.keys(node).filter(k => !allowedKeys.includes(k));
  if (unexpectedKeys.length > 0) {
    errors.push(`Unexpected properties in N_OF_M node: ${unexpectedKeys.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Safe JSON parse with validation
 * Returns parsed and validated AST or null if invalid
 */
export function parseAndValidateRuleJSON(json: string): {
  ast: RuleNode | null;
  validation: ValidationResult;
} {
  try {
    if (json.includes('"__proto__"') || json.includes('"prototype"') || json.includes('"constructor"')) {
      return {
        ast: null,
        validation: {
          valid: false,
          errors: ['Prototype injection attempt detected'],
        },
      };
    }
    const parsed = JSON.parse(json);
    const validation = validateRuleAST(parsed);
    
    if (validation.valid) {
      return { ast: parsed as RuleNode, validation };
    }
    
    return { ast: null, validation };
  } catch (error) {
    return {
      ast: null,
      validation: {
        valid: false,
        errors: [`JSON parse error: ${error instanceof Error ? error.message : 'Unknown error'}`],
      },
    };
  }
}
