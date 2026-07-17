/**
 * End-to-End Governance Example
 * 
 * Demonstrates complete governance workflow:
 * 1. Create a governance rule
 * 2. Create an approval request
 * 3. Submit approvals
 * 4. Evaluate the rule with approvals
 */

import {
  evaluateRule,
  createGovernanceContext,
  formatTrace,
  validateRuleAST,
  RuleNode,
  ApprovalRecord,
  ContributionScore,
} from '../src';
import { RoleContext } from '@guildpass/shared-types';

/**
 * Scenario: High-Value Proposal Approval
 * 
 * Rule: Requires 2-of-3 admin approvals
 * Actors:
 * - Proposer: regular member
 * - Admin 1, 2, 3: admins who can approve
 */

async function highValueProposalScenario() {
  console.log('=== High-Value Proposal Approval Scenario ===\n');

  // Step 1: Define the governance rule
  const rule: RuleNode = {
    type: 'RequiresApprovals',
    threshold: 2,
    approverRole: 'admin',
  };

  console.log('Step 1: Governance Rule Definition');
  console.log(JSON.stringify(rule, null, 2));
  console.log();

  // Validate the rule
  const validation = validateRuleAST(rule);
  if (!validation.valid) {
    console.error('Rule validation failed:', validation.errors);
    return;
  }
  console.log('✓ Rule is valid\n');

  // Step 2: Proposer submits a proposal
  const proposer = {
    wallet: '0xProposer123',
    communityId: 'dao-guild',
    roleContext: {
      assignments: [{ role: 'member' as const, source: 'auto' as const, active: true }],
      membershipState: 'active' as const,
    },
    contributionScore: { total: 50 },
  };

  console.log('Step 2: Proposer Details');
  console.log(`Wallet: ${proposer.wallet}`);
  console.log(`Role: ${proposer.roleContext.assignments[0].role}`);
  console.log(`Contribution Score: ${proposer.contributionScore.total}`);
  console.log();

  // Step 3: Initially no approvals - should fail
  console.log('Step 3: Initial Evaluation (no approvals)');
  let context = createGovernanceContext(
    proposer.wallet,
    proposer.communityId,
    proposer.roleContext,
    proposer.contributionScore,
    [], // No approvals yet
    'proposal-001',
  );

  let result = evaluateRule(rule, context);
  console.log(`Result: ${result.allowed ? 'ALLOWED' : 'DENIED'}`);
  console.log(formatTrace(result.trace));
  console.log();

  // Step 4: Admin 1 approves
  console.log('Step 4: Admin 1 Approves');
  const approval1: ApprovalRecord = {
    id: 'approval-1',
    requestId: 'proposal-001',
    approverWallet: '0xAdmin001',
    approverRole: 'admin',
    approved: true,
    timestamp: new Date().toISOString(),
  };
  console.log(`✓ ${approval1.approverWallet} approved`);
  console.log();

  // Re-evaluate with 1 approval
  console.log('Step 5: Re-evaluation (1 approval)');
  context = createGovernanceContext(
    proposer.wallet,
    proposer.communityId,
    proposer.roleContext,
    proposer.contributionScore,
    [approval1],
    'proposal-001',
  );

  result = evaluateRule(rule, context);
  console.log(`Result: ${result.allowed ? 'ALLOWED' : 'DENIED'}`);
  console.log(formatTrace(result.trace));
  console.log();

  // Step 6: Admin 2 approves (threshold met!)
  console.log('Step 6: Admin 2 Approves');
  const approval2: ApprovalRecord = {
    id: 'approval-2',
    requestId: 'proposal-001',
    approverWallet: '0xAdmin002',
    approverRole: 'admin',
    approved: true,
    timestamp: new Date().toISOString(),
  };
  console.log(`✓ ${approval2.approverWallet} approved`);
  console.log();

  // Final evaluation with 2 approvals
  console.log('Step 7: Final Evaluation (2 approvals - THRESHOLD MET!)');
  context = createGovernanceContext(
    proposer.wallet,
    proposer.communityId,
    proposer.roleContext,
    proposer.contributionScore,
    [approval1, approval2],
    'proposal-001',
  );

  result = evaluateRule(rule, context);
  console.log(`Result: ${result.allowed ? '✓ ALLOWED' : '✗ DENIED'}`);
  console.log(formatTrace(result.trace));
  console.log();

  console.log('=== Scenario Complete ===\n');
}

/**
 * Scenario: Contribution-Based Access
 * 
 * Rule: Admin OR (Contributor AND Score >= 100)
 */
async function contributionBasedAccessScenario() {
  console.log('=== Contribution-Based Access Scenario ===\n');

  // Step 1: Define the rule
  const rule: RuleNode = {
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

  console.log('Step 1: Rule Definition');
  console.log('Admin OR (Contributor AND Score >= 100)');
  console.log();

  // Test Case 1: Admin with low score (should pass)
  console.log('Test Case 1: Admin with low score');
  let context = createGovernanceContext(
    '0xAdmin',
    'dao-guild',
    {
      assignments: [{ role: 'admin', source: 'manual', active: true }],
      membershipState: 'active',
    },
    { total: 10 }, // Low score, but doesn't matter for admin
  );

  let result = evaluateRule(rule, context);
  console.log(`Result: ${result.allowed ? '✓ ALLOWED' : '✗ DENIED'}`);
  console.log(`Reason: ${result.trace.details}`);
  console.log();

  // Test Case 2: Contributor with high score (should pass)
  console.log('Test Case 2: Contributor with high score');
  context = createGovernanceContext(
    '0xContributor',
    'dao-guild',
    {
      assignments: [{ role: 'contributor', source: 'manual', active: true }],
      membershipState: 'active',
    },
    { total: 150 },
  );

  result = evaluateRule(rule, context);
  console.log(`Result: ${result.allowed ? '✓ ALLOWED' : '✗ DENIED'}`);
  console.log(`Reason: ${result.trace.details}`);
  console.log();

  // Test Case 3: Contributor with low score (should fail)
  console.log('Test Case 3: Contributor with low score');
  context = createGovernanceContext(
    '0xContributor2',
    'dao-guild',
    {
      assignments: [{ role: 'contributor', source: 'manual', active: true }],
      membershipState: 'active',
    },
    { total: 50 }, // Below threshold
  );

  result = evaluateRule(rule, context);
  console.log(`Result: ${result.allowed ? '✓ ALLOWED' : '✗ DENIED'}`);
  console.log(`Reason: ${result.trace.details}`);
  console.log();

  // Test Case 4: Regular member (should fail)
  console.log('Test Case 4: Regular member');
  context = createGovernanceContext(
    '0xMember',
    'dao-guild',
    {
      assignments: [{ role: 'member', source: 'auto', active: true }],
      membershipState: 'active',
    },
    { total: 200 }, // High score, but not a contributor
  );

  result = evaluateRule(rule, context);
  console.log(`Result: ${result.allowed ? '✓ ALLOWED' : '✗ DENIED'}`);
  console.log(`Reason: ${result.trace.details}`);
  console.log();

  console.log('=== Scenario Complete ===\n');
}

/**
 * Scenario: N-of-M Flexible Access
 * 
 * Rule: 2 of 3 conditions (Admin, High Score, Active Member)
 */
async function flexibleAccessScenario() {
  console.log('=== Flexible N-of-M Access Scenario ===\n');

  const rule: RuleNode = {
    type: 'N_OF_M',
    n: 2,
    rules: [
      { type: 'HasRole', role: 'admin' },
      { type: 'MinContributionScore', score: 100 },
      { type: 'HasMembershipState', state: 'active' },
    ],
  };

  console.log('Step 1: Rule Definition');
  console.log('Need 2 of 3: [Admin Role, Score >= 100, Active Membership]');
  console.log();

  // Test Case 1: Admin + Active (2/3) - should pass
  console.log('Test Case 1: Admin + Active (no score)');
  let context = createGovernanceContext(
    '0xUser1',
    'dao-guild',
    {
      assignments: [{ role: 'admin', source: 'manual', active: true }],
      membershipState: 'active',
    },
    { total: 0 },
  );

  let result = evaluateRule(rule, context);
  console.log(`Result: ${result.allowed ? '✓ ALLOWED' : '✗ DENIED'}`);
  console.log(`Passed: ${result.trace.metadata?.passed}/3 conditions`);
  console.log();

  // Test Case 2: High Score + Active (2/3) - should pass
  console.log('Test Case 2: High Score + Active (not admin)');
  context = createGovernanceContext(
    '0xUser2',
    'dao-guild',
    {
      assignments: [{ role: 'contributor', source: 'manual', active: true }],
      membershipState: 'active',
    },
    { total: 150 },
  );

  result = evaluateRule(rule, context);
  console.log(`Result: ${result.allowed ? '✓ ALLOWED' : '✗ DENIED'}`);
  console.log(`Passed: ${result.trace.metadata?.passed}/3 conditions`);
  console.log();

  // Test Case 3: Only Active (1/3) - should fail
  console.log('Test Case 3: Only Active (not admin, low score)');
  context = createGovernanceContext(
    '0xUser3',
    'dao-guild',
    {
      assignments: [{ role: 'member', source: 'auto', active: true }],
      membershipState: 'active',
    },
    { total: 10 },
  );

  result = evaluateRule(rule, context);
  console.log(`Result: ${result.allowed ? '✓ ALLOWED' : '✗ DENIED'}`);
  console.log(`Passed: ${result.trace.metadata?.passed}/3 conditions`);
  console.log();

  console.log('=== Scenario Complete ===\n');
}

/**
 * Run all scenarios
 */
async function runAllScenarios() {
  try {
    await highValueProposalScenario();
    await contributionBasedAccessScenario();
    await flexibleAccessScenario();

    console.log('✓ All scenarios completed successfully');
  } catch (error) {
    console.error('Error running scenarios:', error);
  }
}

// Export for use in other files or run directly
if (require.main === module) {
  runAllScenarios();
}

export {
  highValueProposalScenario,
  contributionBasedAccessScenario,
  flexibleAccessScenario,
  runAllScenarios,
};
