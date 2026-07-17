/**
 * Basic Governance Rule Examples
 * 
 * This file demonstrates common governance rule patterns
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
} from '../src/ast';

/**
 * Example 1: Simple Role Check
 * Use Case: Admin-only access
 */
export const adminOnlyRule: HasRoleNode = {
  type: 'HasRole',
  role: 'admin',
};

/**
 * Example 2: Contribution Score Threshold
 * Use Case: High contributors get special access
 */
export const highContributorRule: MinContributionScoreNode = {
  type: 'MinContributionScore',
  score: 100,
};

/**
 * Example 3: Active Membership Required
 * Use Case: Only active members can vote
 */
export const activeMemberRule: HasMembershipStateNode = {
  type: 'HasMembershipState',
  state: 'active',
};

/**
 * Example 4: Multi-Party Approval
 * Use Case: High-value proposals need 2-of-3 admin approvals
 */
export const twoOfThreeAdminApprovalsRule: RequiresApprovalsNode = {
  type: 'RequiresApprovals',
  threshold: 2,
  approverRole: 'admin',
};

/**
 * Example 5: Admin OR High Contributor
 * Use Case: Access for admins or contributors with high score
 */
export const adminOrHighContributorRule: OrNode = {
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

/**
 * Example 6: Active Member AND (Admin OR Contributor)
 * Use Case: Only active admins or contributors can perform action
 */
export const activeMemberWithRoleRule: AndNode = {
  type: 'AND',
  rules: [
    { type: 'HasMembershipState', state: 'active' },
    {
      type: 'OR',
      rules: [
        { type: 'HasRole', role: 'admin' },
        { type: 'HasRole', role: 'contributor' },
      ],
    },
  ],
};

/**
 * Example 7: NOT Suspended
 * Use Case: Ensure user is not suspended
 */
export const notSuspendedRule: NotNode = {
  type: 'NOT',
  rule: {
    type: 'HasMembershipState',
    state: 'suspended',
  },
};

/**
 * Example 8: 2-of-3 Conditions
 * Use Case: Flexible access - need any 2 of: admin role, high score, or long-term member
 */
export const flexibleAccessRule: NOfMNode = {
  type: 'N_OF_M',
  n: 2,
  rules: [
    { type: 'HasRole', role: 'admin' },
    { type: 'MinContributionScore', score: 150 },
    { type: 'HasMembershipState', state: 'active' },
  ],
};

/**
 * Example 9: Complex Proposal Approval
 * Use Case: High-value proposals need admin approval AND contributor endorsement
 */
export const complexProposalRule: AndNode = {
  type: 'AND',
  rules: [
    { type: 'HasMembershipState', state: 'active' },
    {
      type: 'RequiresApprovals',
      threshold: 2,
      approverRole: 'admin',
    },
    {
      type: 'OR',
      rules: [
        { type: 'HasRole', role: 'contributor' },
        { type: 'MinContributionScore', score: 200 },
      ],
    },
  ],
};

/**
 * Example 10: Emergency Override
 * Use Case: Normal contributor access OR emergency admin override
 */
export const emergencyOverrideRule: OrNode = {
  type: 'OR',
  rules: [
    // Normal path: active contributor with good score
    {
      type: 'AND',
      rules: [
        { type: 'HasRole', role: 'contributor' },
        { type: 'HasMembershipState', state: 'active' },
        { type: 'MinContributionScore', score: 50 },
      ],
    },
    // Emergency path: 3 admin approvals
    {
      type: 'RequiresApprovals',
      threshold: 3,
      approverRole: 'admin',
    },
  ],
};

/**
 * Example 11: Graduated Access
 * Use Case: Different score tiers grant different access levels
 */
export const graduatedAccessRule: OrNode = {
  type: 'OR',
  rules: [
    // Tier 3: Admin (unrestricted)
    { type: 'HasRole', role: 'admin' },
    // Tier 2: High contributor (score >= 200)
    {
      type: 'AND',
      rules: [
        { type: 'HasRole', role: 'contributor' },
        { type: 'MinContributionScore', score: 200 },
      ],
    },
    // Tier 1: Regular contributor (score >= 100)
    {
      type: 'AND',
      rules: [
        { type: 'HasRole', role: 'contributor' },
        { type: 'MinContributionScore', score: 100 },
      ],
    },
  ],
};

/**
 * Example 12: Unanimous Approval
 * Use Case: Critical actions need all 3 admins to approve
 */
export const unanimousApprovalRule: RequiresApprovalsNode = {
  type: 'RequiresApprovals',
  threshold: 3,
  approverRole: 'admin',
};

/**
 * Example usage in JSON format for API calls
 */
export const exampleRulesJSON = {
  simpleAdmin: JSON.stringify(adminOnlyRule, null, 2),
  contributorScore: JSON.stringify(highContributorRule, null, 2),
  activeMember: JSON.stringify(activeMemberRule, null, 2),
  multiPartyApproval: JSON.stringify(twoOfThreeAdminApprovalsRule, null, 2),
  adminOrContributor: JSON.stringify(adminOrHighContributorRule, null, 2),
  complexProposal: JSON.stringify(complexProposalRule, null, 2),
  emergencyOverride: JSON.stringify(emergencyOverrideRule, null, 2),
};

/**
 * Helper: Create a rule with metadata
 */
export function createRuleDefinition(
  name: string,
  description: string,
  ast: RuleNode,
) {
  return {
    name,
    description,
    ast,
    metadata: {
      createdBy: 'governance-examples',
      version: '1.0.0',
      tags: ['example'],
    },
  };
}

/**
 * Example rule definitions ready for API submission
 */
export const exampleRuleDefinitions = [
  createRuleDefinition(
    'Admin Only',
    'Only administrators can access this resource',
    adminOnlyRule,
  ),
  createRuleDefinition(
    'High Contributor',
    'Contributors with score >= 100',
    highContributorRule,
  ),
  createRuleDefinition(
    'Admin or High Contributor',
    'Admins or contributors with score >= 100',
    adminOrHighContributorRule,
  ),
  createRuleDefinition(
    '2-of-3 Admin Approvals',
    'Requires at least 2 admin approvals',
    twoOfThreeAdminApprovalsRule,
  ),
  createRuleDefinition(
    'Complex Proposal',
    'Multi-stage approval for high-value proposals',
    complexProposalRule,
  ),
];
