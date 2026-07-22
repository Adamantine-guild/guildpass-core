export type WalletAddress = `0x${string}`;

export type MembershipState = "invited" | "active" | "expired" | "suspended";

export type Role = "admin" | "member" | "contributor";

// --- Role Hierarchy & Delegation Types ---
export interface RoleDefinition {
  id: string;
  name: string;
  communityId: string;
  description?: string | null;
  parentRoleId?: string | null;
  builtInRole?: Role | null;
  createdAt: string;
  updatedAt: string;
}

export interface DelegatedGrant {
  id: string;
  communityId: string;
  granterWalletId: string;
  granteeWalletId: string;
  roles: string[];
  scope?: Record<string, any> | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
  createdAt: string;
}

export interface RoleAssignment {
  role: Role;
  roleDefinitionId?: string | null;
  source: "manual" | "auto";
  active: boolean;
  expiresAt?: string | Date | null;
}

// --- Wallet Linking Types ---

export interface Challenge {
  nonce: string;
  expiresAt: string; // ISO datetime
  issuedAt: string; // ISO datetime
  primaryWallet: WalletAddress;
  secondaryWallet: WalletAddress;
  communityId?: string; // Optional, if linking in a specific community context
}

export interface LinkWalletInput {
  challenge: Challenge;
  signature: string;
}

export interface LinkedWallet {
  id: string;
  primaryWalletId: string; // Foreign key to Wallet (the identity's primary)
  secondaryWalletId: string; // Foreign key to Wallet
  primaryWalletAddress: WalletAddress;
  secondaryWalletAddress: WalletAddress;
  linkedAt: string; // ISO datetime
}

// Aggregated RoleContext that includes state from all linked wallets
export interface AggregatedRoleContext {
  primaryWallet: WalletAddress;
  linkedWallets: WalletAddress[];
  // Union of all assignments from primary and linked wallets
  assignments: RoleAssignment[];
  // If ANY linked wallet has an active membership in the community, we consider it active
  membershipState: MembershipState;
  // All overrides that apply to ANY linked wallet
  overrides: AccessOverride[];
  communityId?: string;
  resource?: string;
}

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

export type AccessOverrideEffect = "ALLOW" | "DENY";

export interface AccessOverride {
  id?: string;
  wallet: WalletAddress | string;
  communityId: string;
  resource: string;
  effect: AccessOverrideEffect;
  expiresAt?: string | Date | null;
  reason?: string | null;
  createdAt?: string | Date;
}

export interface AccessOverrideMutationInput {
  requesterWallet: WalletAddress;
  communityId: string;
  wallet: WalletAddress;
  resource: string;
  effect: AccessOverrideEffect;
  reason?: string;
  expiresAt?: string | Date | null;
}

export interface AccessOverrideMutationResult {
  communityId: string;
  wallet: WalletAddress;
  resource: string;
  effect: AccessOverrideEffect;
  created: boolean;
  removed: boolean;
  message?: string;
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
  expiresAt?: string | Date | null;
}

export interface AssignRoleInput {
  requesterWallet: WalletAddress;
  communityId: string;
  targetWallet: WalletAddress;
  role: Role;
}

export interface RemoveRoleInput {
  requesterWallet: WalletAddress;
  communityId: string;
  targetWallet: WalletAddress;
  role: Role;
}

export interface RoleMutationResult {
  communityId: string;
  wallet: WalletAddress;
  role: Role;
  assigned: boolean;
  removed: boolean;
  message?: string;
}

// --- Badge Types ---

export interface BadgeDto {
  id: string;
  memberId: string;
  label: string;
  issuedAt: string; // ISO datetime
}

export interface AssignBadgeInput {
  requesterWallet: WalletAddress;
  communityId: string;
  targetWallet: WalletAddress;
  label: string;
}

export interface RevokeBadgeInput {
  requesterWallet: WalletAddress;
  communityId: string;
  targetWallet: WalletAddress;
  badgeId: string;
}

export interface BadgeMutationResult {
  communityId: string;
  wallet: WalletAddress;
  badge?: BadgeDto;
  assigned: boolean;
  removed: boolean;
  message?: string;
}

export interface ListBadgesResult {
  communityId: string;
  wallet: WalletAddress;
  badges: BadgeDto[];
}

export interface RoleContext {
  assignments: RoleAssignment[];
  membershipState: MembershipState;
  wallet?: WalletAddress | string;
  communityId?: string;
  resource?: string;
  overrides?: AccessOverride[];
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

// --- Integration Event Outbox ---

export type OutboxEventType =
  | "MEMBERSHIP_CREATED"
  | "MEMBERSHIP_UPDATED"
  | "MEMBERSHIP_DELETED"
  | "ROLE_ASSIGNED"
  | "ROLE_REMOVED"
  | "RESOURCE_CREATED"
  | "RESOURCE_UPDATED"
  | "RESOURCE_ARCHIVED"
  | "POLICY_CREATED"
  | "POLICY_UPDATED"
  | "POLICY_DELETED"
  | "ACCESS_DECISION"
  | "ACCESS_OVERRIDE_CREATED"
  | "ACCESS_OVERRIDE_REVOKED"
  | "MEMBER_ATTENDED"
  | "BADGE_ASSIGNED"
  | "BADGE_REVOKED";

export type OutboxEventStatus = "pending" | "delivered" | "failed";

export interface OutboxEventDto {
  id?: string;
  eventType: OutboxEventType;
  entityId?: string | null;
  entityType?: string | null;
  communityId?: string | null;
  payload?: Record<string, unknown>;
  status?: OutboxEventStatus;
  retryCount?: number;
  maxRetries?: number;
  lastError?: string | null;
  createdAt?: string;
  deliveredAt?: string | null;
  nextRetryAt?: string | null;
}

export interface OutboxDispatchResult {
  eventId: string;
  status: OutboxEventStatus;
}

// --- Webhook Delivery ---

export interface WebhookSubscriptionDto {
  id?: string;
  communityId: string;
  url: string;
  /** Never included in read responses — write-only. */
  secret?: string;
  eventTypes: OutboxEventType[];
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type DeadLetterStatus = "pending" | "retried" | "resolved";

export interface DeadLetterEventDto {
  id: string;
  originalEventId: string;
  eventType: string;
  entityId?: string | null;
  entityType?: string | null;
  communityId?: string | null;
  payload?: Record<string, unknown>;
  failureReason: string;
  retryCount: number;
  status: DeadLetterStatus;
  createdAt: string;
  resolvedAt?: string | null;
}

export * from "./apiContract";
