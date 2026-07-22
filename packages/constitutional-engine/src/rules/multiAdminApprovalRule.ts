/**
 * Reference Constitutional Rule #2: Multi-Admin Approval Rule (N-of-M)
 *
 * Enforces that critical system mutations (role assignment, policy updates, override creations)
 * require a minimum threshold N of M approval records from admins.
 */

import {
  ConstitutionalRule,
  EvaluationTrace,
  MultiAdminApprovalParams,
  MutationContext,
} from '../types';

export function evaluateMultiAdminApprovalRule(
  rule: ConstitutionalRule,
  context: MutationContext,
  now: Date = new Date(),
): EvaluationTrace {
  const params = rule.params as MultiAdminApprovalParams;
  const requiredApprovals = params.requiredApprovals || 1;
  const requiredRole = (params.approverRole || 'admin').toLowerCase();
  const maxAgeMs = params.approvalMaxAgeSeconds ? params.approvalMaxAgeSeconds * 1000 : null;

  const approvals = context.approvals || [];
  const currentTime = now.getTime();

  // Deduplicate approvals by approver wallet address and filter by role & freshness
  const validApproverWallets = new Set<string>();

  for (const approval of approvals) {
    if (!approval.wallet) continue;

    const approverRole = (approval.role || '').toLowerCase();
    if (approverRole !== requiredRole) continue;

    if (maxAgeMs !== null && approval.timestamp) {
      const approvalTime = new Date(approval.timestamp).getTime();
      if (currentTime - approvalTime > maxAgeMs) {
        continue; // Expired approval
      }
    }

    validApproverWallets.add(approval.wallet.toLowerCase());
  }

  const validCount = validApproverWallets.size;
  const passed = validCount >= requiredApprovals;

  const approversList = Array.from(validApproverWallets);

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    targetAction: rule.targetAction,
    passed,
    effect: rule.effect,
    details: passed
      ? `Multi-admin approval passed: Collected ${validCount} of ${requiredApprovals} required approvals from role "${requiredRole}"`
      : `Multi-admin approval pending/failed: Collected only ${validCount} of ${requiredApprovals} required approvals from role "${requiredRole}"`,
    metadata: {
      requiredApprovals,
      validCount,
      requiredRole,
      approvers: approversList,
    },
  };
}
