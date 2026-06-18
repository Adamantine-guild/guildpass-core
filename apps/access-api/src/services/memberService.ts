/**
 * memberService.ts
 *
 * Business logic for membership and access-check operations.
 *
 * Observability additions:
 *   - Every call to `checkAccess` increments `access_policy_decisions_total`
 *     labelled by { outcome, rule_id, reason_code }.
 *   - Wallet addresses are NEVER written to log lines; use maskWallet() when
 *     a structured log entry needs to reference a wallet for debugging.
 */

import { evaluate } from '@guildpass/policy-engine';
import { AccessCheckInput, AccessDecision, MembershipState, RoleContext } from '@guildpass/shared-types';
import { PrismaClient } from '@prisma/client';
import { metrics, maskWallet } from '../observability';

/**
 * Normalizes membership state by checking expiry at read time.
 * Returns 'expired' if the membership has a past expiresAt value,
 * otherwise returns the original state.
 */
function getNormalizedMembershipState(
  state: MembershipState | undefined | null,
  expiresAt: Date | null | undefined,
  now: Date = new Date()
): MembershipState {
  const normalizedState = (state || 'invited') as MembershipState;

  if (!expiresAt) return normalizedState;
  if (expiresAt < now) return 'expired';
  return normalizedState;
}

export function getMemberService(prisma: PrismaClient) {
  return {
    async getMembershipsByWallet(wallet: string) {
      const w = await prisma.wallet.findUnique({ where: { address: wallet.toLowerCase() } });
      if (!w) return { wallet, communities: [] };

      const members = await prisma.member.findMany({
        where: { walletId: w.id },
        include: { membership: true },
      });

      const communities = members.map((m) => ({
        communityId: m.communityId,
        state: getNormalizedMembershipState(m.membership?.state, m.membership?.expiresAt),
        expiresAt: m.membership?.expiresAt?.toISOString() ?? null,
      }));

      return { wallet, communities };
    },

    async getProfileByWallet(wallet: string) {
      const w = await prisma.wallet.findUnique({ where: { address: wallet.toLowerCase() } });
      if (!w) return null;

      const m = await prisma.member.findFirst({
        where: { walletId: w.id },
        include: { profile: true, membership: true, roles: true },
      });
      if (!m) return null;

      return {
        wallet,
        communityId: m.communityId,
        profile: {
          id: m.profile?.id ?? '',
          displayName: m.profile?.displayName ?? '',
          bio: m.profile?.bio ?? '',
        },
        membership: {
          state: getNormalizedMembershipState(m.membership?.state, m.membership?.expiresAt),
          expiresAt: m.membership?.expiresAt?.toISOString() ?? null,
        },
        roles: m.roles.filter((r) => r.active).map((r) => r.role),
      };
    },

    async checkAccess(input: AccessCheckInput): Promise<AccessDecision> {
      const wallet = input.wallet.toLowerCase();

      const w = await prisma.wallet.findUnique({ where: { address: wallet } });
      if (!w) {
        const decision: AccessDecision = {
          allowed: false,
          code: 'DENY',
          reasons: [{ code: 'NO_WALLET', message: 'Wallet not known' }],
          membershipState: 'invited',
          effectiveRoles: [],
        };
        // ------------------------------------------------------------------
        // Telemetry: record the deny decision.
        // rule_id is 'none' because we never reached policy evaluation.
        // ------------------------------------------------------------------
        metrics.accessDecisionsTotal.inc({
          outcome: 'DENY',
          rule_id: 'none',
          reason_code: 'NO_WALLET',
        });
        return decision;
      }

      const member = await prisma.member.findFirst({
        where: { walletId: w.id, communityId: input.communityId },
        include: { roles: true, membership: true },
      });
      if (!member) {
        const decision: AccessDecision = {
          allowed: false,
          code: 'DENY',
          reasons: [{ code: 'NOT_MEMBER', message: 'Wallet is not a member of community' }],
          membershipState: 'invited',
          effectiveRoles: [],
        };
        metrics.accessDecisionsTotal.inc({
          outcome: 'DENY',
          rule_id: 'none',
          reason_code: 'NOT_MEMBER',
        });
        return decision;
      }

      const policy = await prisma.accessPolicy.findFirst({
        where: { communityId: input.communityId, resource: input.resource },
      });

      const rule = policy ? policy.rule : 'MEMBERS_ONLY';
      const ruleId = policy?.id ?? 'default';

      const normalizedState = getNormalizedMembershipState(
        member.membership?.state,
        member.membership?.expiresAt,
      );

      const ctx: RoleContext = {
        assignments: member.roles.map((r) => ({
          role: r.role as any,
          source: r.source as any,
          active: r.active,
        })),
        membershipState: normalizedState,
      };

      const decision = evaluate(
        {
          id: ruleId,
          communityId: input.communityId,
          resource: input.resource,
          rule: rule as any,
        },
        ctx,
      );

      // --------------------------------------------------------------------
      // Telemetry: record every policy engine outcome with enough context to
      // build dashboards per rule and denial reason without exposing wallet data.
      // --------------------------------------------------------------------
      const firstReasonCode = decision.reasons?.[0]?.code ?? 'none';
      metrics.accessDecisionsTotal.inc({
        outcome: decision.code,           // "ALLOW" | "DENY"
        rule_id: rule,                    // "MEMBERS_ONLY" | "PUBLIC" | …
        reason_code: firstReasonCode,     // e.g. "EXPIRED_MEMBERSHIP"
      });

      return decision;
    },

    async listMembersForAdmin(
      communityId: string,
      role?: 'admin' | 'member' | 'contributor',
      limit: number = 50,
      cursor?: string,
    ) {
      // TODO: add auth to ensure requester is admin
      const maxLimit = 100;
      const take = Math.min(Math.max(1, Math.floor(limit)), maxLimit);

      // Build where clause. Apply role filtering at the DB level when provided.
      const where: any = { communityId };
      if (role) {
        where.roles = { some: { role, active: true } };
      }

      const members = await prisma.member.findMany({
        where,
        include: { wallet: true, membership: true, roles: true, profile: true },
        orderBy: { id: 'asc' },
        take: take + 1, // fetch one extra to determine nextCursor
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = members.length > take;
      const page = hasMore ? members.slice(0, take) : members;

      const list = page.map((m) => {
        const activeRoles = m.roles.filter((r) => r.active).map((r) => r.role);
        return {
          wallet: m.wallet.address,
          displayName: m.profile?.displayName ?? null,
          state: getNormalizedMembershipState(m.membership?.state, m.membership?.expiresAt),
          roles: activeRoles,
          id: m.id,
        };
      });

      const nextCursor = hasMore ? page[page.length - 1].id : null;

      return { communityId, members: list, limit: take, nextCursor };
    },
  };
}
