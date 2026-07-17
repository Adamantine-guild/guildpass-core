/**
 * Constitutional Rule Engine - Abstract Syntax Tree (AST) Definitions
 *
 * This module defines the JSON-serializable AST for governance rules.
 * All rules are data structures - NO executable code is supported.
 *
 * Design Philosophy:
 * - Simple, explainable governance rules
 * - Composable from primitive predicates
 * - Fully serializable as JSON
 * - Type-safe at compile time
 * - Validated at runtime
 */

import { Role, MembershipState } from '@guildpass/shared-types';

/**
 * Base Rule Node
 * All rule nodes must have a type discriminator
 */
export interface BaseRuleNode {
  type: string;
}

/**
 * Primitive Predicate: HasRole
 * Checks if the user has a specific role
 */
export interface HasRoleNode extends BaseRuleNode {
  type: 'HasRole';
  role: Role;
}

/**
 * Primitive Predicate: MinContributionScore
 * Checks if the user meets a minimum contribution score threshold
 */
export interface MinContributionScoreNode extends BaseRuleNode {
  type: 'MinContributionScore';
  score: number;
}

/**
 * Primitive Predicate: HasMembershipState
 * Checks if the user has a specific membership state
 */
export interface HasMembershipStateNode extends BaseRuleNode {
  type: 'HasMembershipState';
  state: MembershipState;
}

/**
 * Primitive Predicate: RequiresApprovals
 * Checks if the required number of approvals from a specific role exists
 */
export interface RequiresApprovalsNode extends BaseRuleNode {
  type: 'RequiresApprovals';
  threshold: number;
  approverRole: Role;
  requestId?: string; // Optional: specific approval request ID
}

/**
 * Boolean Combinator: AND
 * All child rules must evaluate to true
 */
export interface AndNode extends BaseRuleNode {
  type: 'AND';
  rules: RuleNode[];
}

/**
 * Boolean Combinator: OR
 * At least one child rule must evaluate to true
 */
export interface OrNode extends BaseRuleNode {
  type: 'OR';
  rules: RuleNode[];
}

/**
 * Boolean Combinator: NOT
 * Negates the child rule
 */
export interface NotNode extends BaseRuleNode {
  type: 'NOT';
  rule: RuleNode;
}

/**
 * Boolean Combinator: N_OF_M
 * At least N of M child rules must evaluate to true
 */
export interface NOfMNode extends BaseRuleNode {
  type: 'N_OF_M';
  n: number;
  rules: RuleNode[];
}

/**
 * Union type of all possible rule nodes
 */
export type RuleNode =
  | HasRoleNode
  | MinContributionScoreNode
  | HasMembershipStateNode
  | RequiresApprovalsNode
  | AndNode
  | OrNode
  | NotNode
  | NOfMNode;

/**
 * Governance Rule Definition
 * Top-level container for a constitutional rule
 */
export interface GovernanceRule {
  id: string;
  name: string;
  description: string;
  communityId: string;
  resource: string;
  ast: RuleNode;
  active: boolean;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

/**
 * Approval Record
 * Represents an approval from a specific wallet
 */
export interface ApprovalRecord {
  id: string;
  requestId: string;
  approverWallet: string;
  approverRole: Role;
  approved: boolean; // true = approved, false = rejected
  timestamp: Date | string;
  signature?: string; // Optional cryptographic signature
}

/**
 * Approval Request
 * Represents a request for approvals (e.g., for RequiresApprovals predicate)
 */
export interface ApprovalRequest {
  id: string;
  communityId: string;
  resource: string;
  requesterWallet: string;
  ruleId: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expiresAt?: Date | string;
  createdAt: Date | string;
}

/**
 * Type guards for runtime type checking
 */
export function isHasRoleNode(node: RuleNode): node is HasRoleNode {
  return node.type === 'HasRole';
}

export function isMinContributionScoreNode(node: RuleNode): node is MinContributionScoreNode {
  return node.type === 'MinContributionScore';
}

export function isHasMembershipStateNode(node: RuleNode): node is HasMembershipStateNode {
  return node.type === 'HasMembershipState';
}

export function isRequiresApprovalsNode(node: RuleNode): node is RequiresApprovalsNode {
  return node.type === 'RequiresApprovals';
}

export function isAndNode(node: RuleNode): node is AndNode {
  return node.type === 'AND';
}

export function isOrNode(node: RuleNode): node is OrNode {
  return node.type === 'OR';
}

export function isNotNode(node: RuleNode): node is NotNode {
  return node.type === 'NOT';
}

export function isNOfMNode(node: RuleNode): node is NOfMNode {
  return node.type === 'N_OF_M';
}

/**
 * Check if a node is a primitive predicate (leaf node)
 */
export function isPrimitiveNode(node: RuleNode): boolean {
  return (
    isHasRoleNode(node) ||
    isMinContributionScoreNode(node) ||
    isHasMembershipStateNode(node) ||
    isRequiresApprovalsNode(node)
  );
}

/**
 * Check if a node is a combinator (non-leaf node)
 */
export function isCombinatorNode(node: RuleNode): boolean {
  return (
    isAndNode(node) ||
    isOrNode(node) ||
    isNotNode(node) ||
    isNOfMNode(node)
  );
}
