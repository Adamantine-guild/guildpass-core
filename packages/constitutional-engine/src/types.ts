/**
 * Constitutional Rule Engine Types
 */

export type MutationType =
  | 'ROLE_ASSIGNMENT'
  | 'ROLE_REVOCATION'
  | 'POLICY_UPDATE'
  | 'OVERRIDE_CREATE'
  | 'OVERRIDE_REVOKE'
  | '*';

export type ConstitutionalEffect = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

export interface MutationApproval {
  wallet: string;
  role: string;
  timestamp: Date | string;
  signature?: string;
}

export interface MutationContext {
  action: MutationType;
  communityId: string;
  actorWallet: string;
  targetWallet?: string;
  targetResource?: string;
  proposedData?: Record<string, any>;
  previousMutationTimestamp?: Date | string | null;
  approvals?: MutationApproval[];
  metadata?: Record<string, any>;
}

export interface CooldownParams {
  minIntervalSeconds: number;
  scope?: 'TARGET_WALLET' | 'TARGET_RESOURCE' | 'COMMUNITY';
}

export interface MultiAdminApprovalParams {
  requiredApprovals: number;
  approverRole?: string;
  approvalMaxAgeSeconds?: number;
}

export interface ConstitutionalRule {
  id: string;
  name: string;
  description?: string;
  targetAction: MutationType;
  precedence: number; // Higher numbers evaluate first
  effect: ConstitutionalEffect;
  type: 'COOLDOWN' | 'MULTI_ADMIN_APPROVAL' | 'CUSTOM';
  params: CooldownParams | MultiAdminApprovalParams | Record<string, any>;
  active?: boolean;
}

export interface ConstitutionalRuleSet {
  id: string;
  communityId: string;
  version: number;
  rules: ConstitutionalRule[];
  createdBy?: string;
  createdAt?: Date | string;
  active?: boolean;
}

export interface EvaluationTrace {
  ruleId: string;
  ruleName: string;
  targetAction: string;
  passed: boolean;
  effect: ConstitutionalEffect;
  details: string;
  metadata?: Record<string, any>;
}

export interface EvaluationResult {
  allowed: boolean;
  code: 'CONSTITUTIONAL_ALLOW' | 'CONSTITUTIONAL_DENY' | 'APPROVAL_REQUIRED';
  reasons: Array<{ code: string; message: string }>;
  traces: EvaluationTrace[];
}
