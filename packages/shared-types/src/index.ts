export type WalletAddress = `0x${string}`;

export type MembershipState = "invited" | "active" | "expired" | "suspended";

export type Role = "admin" | "member" | "contributor";

export interface DecisionReason {
  code: string;
  message: string;
}

export type PolicyRuleType =
  | "PUBLIC"
  | "MEMBERS_ONLY"
  | "ADMINS_ONLY"
  | "CONTRIBUTORS_OR_ADMINS"
  | string;

export type AccessPolicyParams = Record<string, unknown> | null;

export interface AccessDecision {
  allowed: boolean;
  code: "ALLOW" | "DENY";
  reasons: DecisionReason[];
  effectiveRoles?: Role[];
  membershipState?: MembershipState;
}

export interface ResourceRef {
  communityId: string;
  resourceId?: string;
  resourceType?: "page" | "content" | "event" | "other";
}

export interface AccessPolicy {
  id: string;
  communityId: string;
  resource: string;
  ruleType: PolicyRuleType;
  params?: AccessPolicyParams;
}

export interface MemberProfile {
  id: string;
  displayName: string;
  bio?: string;
  avatarUrl?: string;
}

export interface MemberStatus {
  wallet: WalletAddress;
  communityId: string;
  state: MembershipState;
  expiresAt?: string | null;
}

export interface AccessCheckInput {
  wallet: WalletAddress;
  communityId: string;
  resource: string;
}

export interface RoleAssignment {
  role: Role;
  source: "manual" | "auto";
  active: boolean;
}

export interface RoleContext {
  assignments: RoleAssignment[];
  membershipState: MembershipState;
}

export interface PolicyEngine {
  evaluate(policy: AccessPolicy, ctx: RoleContext): AccessDecision;
}
export type AuditEventDto = {
  id?: string;
  eventType:
    | "ACCESS_CHECK"
    | "MEMBERSHIP_CREATED"
    | "MEMBERSHIP_UPDATED"
    | "MEMBERSHIP_DELETED"
    | "POLICY_EVALUATION"
    | "OTHER";
  walletId?: string | null;
  communityId?: string | null;
  resource?: string | null;
  policyRule?: string | null;
  decision?: string | null;
  reasonCode?: string | null;
  beforeState?: any | null;
  afterState?: any | null;
  createdAt?: string; // ISO datetime
};

// Also optionally export enums for event types
export type EventType =
  | "ACCESS_CHECK"
  | "MEMBERSHIP_CREATED"
  | "MEMBERSHIP_UPDATED"
  | "MEMBERSHIP_DELETED"
  | "POLICY_EVALUATION"
  | "OTHER";

export * from "./apiContract";
