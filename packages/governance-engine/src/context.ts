/**
 * Constitutional Rule Engine - Evaluation Context
 *
 * Defines the resolved context used for rule evaluation.
 * This contains all the user state needed to evaluate governance rules.
 */

import { Role, MembershipState, RoleContext } from '@guildpass/shared-types';
import { ApprovalRecord } from './ast';

/**
 * Contribution Score
 * Represents a user's contribution metrics
 */
export interface ContributionScore {
  total: number;
  breakdown?: {
    commits?: number;
    reviews?: number;
    proposals?: number;
    other?: number;
  };
}

/**
 * Governance Evaluation Context
 * Contains all resolved state needed for rule evaluation
 */
export interface GovernanceContext {
  // User identity
  wallet: string;
  communityId: string;

  // Membership and role state (from existing policy engine)
  membershipState: MembershipState;
  roles: Role[];
  roleContext: RoleContext;

  // Contribution score (new)
  contributionScore: ContributionScore;

  // Approvals for this specific request (if applicable)
  approvals: ApprovalRecord[];
  
  // Optional: Request ID being evaluated
  requestId?: string;

  // Optional: Additional metadata
  metadata?: Record<string, any>;
}

/**
 * Create a governance context from role context and additional data
 */
export function createGovernanceContext(
  wallet: string,
  communityId: string,
  roleContext: RoleContext,
  contributionScore: ContributionScore,
  approvals: ApprovalRecord[] = [],
  requestId?: string,
): GovernanceContext {
  // Resolve effective roles from role context
  const roles = resolveEffectiveRoles(roleContext);

  return {
    wallet,
    communityId,
    membershipState: roleContext.membershipState,
    roles,
    roleContext,
    contributionScore,
    approvals,
    requestId,
  };
}

/**
 * Resolve effective roles from role context
 * (Imported logic from policy engine for consistency)
 */
function resolveEffectiveRoles(ctx: RoleContext): Role[] {
  const roles: Role[] = [];
  const now = new Date();

  for (const a of ctx.assignments) {
    if (!a.active) continue;
    if (a.expiresAt) {
      const expiry = new Date(a.expiresAt);
      if (expiry < now) continue;
    }
    roles.push(a.role);
  }

  if (ctx.membershipState === 'active') {
    roles.push('member');
  }

  // Role hierarchy implementation:
  // admin -> contributor -> member
  const effective: Role[] = [...roles];
  if (roles.includes('admin')) {
    effective.push('contributor');
    effective.push('member');
  }
  if (roles.includes('contributor')) {
    effective.push('member');
  }

  return Array.from(new Set(effective));
}

/**
 * Default contribution score (zero)
 */
export const DEFAULT_CONTRIBUTION_SCORE: ContributionScore = {
  total: 0,
  breakdown: {},
};
