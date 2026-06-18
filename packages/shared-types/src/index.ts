export type WalletAddress = `0x${string}`;

export type MembershipState = 'invited' | 'active' | 'expired' | 'suspended';

export type Role = 'admin' | 'member' | 'contributor';

export interface DecisionReason {
  code: string;
  message: string;
}

export interface AccessDecision {
  allowed: boolean;
  code: 'ALLOW' | 'DENY';
  reasons: DecisionReason[];
  effectiveRoles?: Role[];
  membershipState?: MembershipState;
}

export interface ResourceRef {
  communityId: string;
  resourceId?: string;
  resourceType?: 'page' | 'content' | 'event' | 'other';
}

export interface AccessPolicy {
  id: string;
  communityId: string;
  resource: string;
  rule: 'PUBLIC' | 'MEMBERS_ONLY' | 'ADMINS_ONLY' | 'CONTRIBUTORS_OR_ADMINS';
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
  source: 'manual' | 'auto';
  active: boolean;
}

export interface RoleContext {
  assignments: RoleAssignment[];
  membershipState: MembershipState;
}

export interface PolicyEngine {
  evaluate(
    policy: AccessPolicy,
    ctx: RoleContext
  ): AccessDecision;
}

export interface MemberListItem {
  id?: string;
  wallet: WalletAddress;
  displayName?: string | null;
  state: MembershipState;
  roles: Role[];
}

export interface PaginatedMembersResponse {
  communityId: string;
  members: MemberListItem[];
  limit: number;
  nextCursor?: string | null;
}
