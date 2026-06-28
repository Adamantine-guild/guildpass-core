import { PrismaClient } from "@prisma/client";
import {
  AccessCheckInput,
  AccessDecision,
  RoleContext,
} from "@guildpass/shared-types";
import { evaluate } from "@guildpass/policy-engine";
import { logEvent } from "./auditService";

import { config } from "../config";
import { createDefaultCacheService } from "./redisCacheService";
import type { CacheService } from "./cacheService";

const prisma = new PrismaClient();

function normaliseWallet(wallet: string): string {
  return wallet.toLowerCase();
}

function accessDecisionCacheKey({
  communityId,
  wallet,
  resource,
  membershipVersion,
  roleVersion,
  policyVersion,
  resourceVersion,
}: {
  communityId: string;
  wallet: string;
  resource: string;
  membershipVersion: number | null;
  roleVersion: number | null;
  policyVersion: number | null;
  resourceVersion: number | null;
}): string {
  return [
    "accessDecision",
    `c:${communityId}`,
    `w:${wallet}`,
    `r:${resource}`,
    `mv:${membershipVersion ?? 0}`,
    `rv:${roleVersion ?? 0}`,
    `pv:${policyVersion ?? 0}`,
    `rsv:${resourceVersion ?? 0}`,
  ].join("|");
}

function membershipVersionKey(communityId: string) {
  return `accessDecisionVersion:membership|c:${communityId}`;
}
function roleVersionKey(communityId: string) {
  return `accessDecisionVersion:roles|c:${communityId}`;
}
function policyVersionKey(communityId: string) {
  return `accessDecisionVersion:policy|c:${communityId}`;
}
function resourceVersionKey(communityId: string) {
  return `accessDecisionVersion:resource|c:${communityId}`;
}

export function getMemberService(prismaClient: PrismaClient) {
  const cacheService: CacheService = createDefaultCacheService(
    config.accessDecisionCacheEnabled,
    config.redisUrl,
  );

  const versionTtlSeconds = config.accessDecisionCacheVersionTtlSeconds;
  const decisionTtlSeconds = config.accessDecisionCacheTtlSeconds;

  async function getVersionedKeyParts(communityId: string) {
    const [membershipVersion, roleVersion, policyVersion, resourceVersion] =
      await Promise.all([
        cacheService.getIncr(membershipVersionKey(communityId)),
        cacheService.getIncr(roleVersionKey(communityId)),
        cacheService.getIncr(policyVersionKey(communityId)),
        cacheService.getIncr(resourceVersionKey(communityId)),
      ]);

    return {
      membershipVersion,
      roleVersion,
      policyVersion,
      resourceVersion,
    };
  }

  async function bumpMembershipVersion(communityId: string) {
    await cacheService.incr(membershipVersionKey(communityId), versionTtlSeconds);
  }
  async function bumpRoleVersion(communityId: string) {
    await cacheService.incr(roleVersionKey(communityId), versionTtlSeconds);
  }
  async function bumpPolicyVersion(communityId: string) {
    await cacheService.incr(policyVersionKey(communityId), versionTtlSeconds);
  }
  async function bumpResourceVersion(communityId: string) {
    await cacheService.incr(resourceVersionKey(communityId), versionTtlSeconds);
  }

  async function auditAccess(input: {
    walletId?: string | null;
    communityId?: string | null;
    resource?: string | null;
    policyRule?: string | null;
    decision: "ALLOW" | "DENY";
    reasonCode?: string | null;
    details?: any;
  }) {
    try {
      await logEvent({
        eventType: "ACCESS_CHECK",
        walletId: input.walletId ?? null,
        communityId: input.communityId ?? null,
        resource: input.resource ?? null,
        policyRule: input.policyRule ?? null,
        decision: input.decision,
        reasonCode: input.reasonCode ?? null,
        beforeState: null,
        afterState: { evaluation: input.details ?? null },
      });
    } catch (err) {
      // Never fail access because audit failed.
      // eslint-disable-next-line no-console
      console.error("Failed to log access audit event:", err);
    }
  }

  async function checkAccess(input: AccessCheckInput): Promise<AccessDecision> {
    const wallet = normaliseWallet(input.wallet);
    const communityId = input.communityId;
    const resource = input.resource;

    const versions = await getVersionedKeyParts(communityId);
    const cacheKey = accessDecisionCacheKey({
      communityId,
      wallet,
      resource,
      ...versions,
    });

    const cached = await cacheService.getJSON<AccessDecision>(cacheKey);
    if (cached) return cached;

    const w = await prismaClient.wallet.findUnique({
      where: { address: wallet },
    });

    if (!w) {
      const decision: AccessDecision = {
        allowed: false,
        code: "DENY",
        reasons: [{ code: "NO_WALLET", message: "Wallet not known" }],
        membershipState: "invited",
        effectiveRoles: [],
      };
      await auditAccess({
        walletId: wallet,
        communityId,
        resource,
        policyRule: null,
        decision: "DENY",
        reasonCode: decision.reasons?.[0]?.code ?? null,
      });
      await cacheService.setJSON(cacheKey, decision, decisionTtlSeconds);
      return decision;
    }

    const member = await prismaClient.member.findFirst({
      where: { walletId: w.id, communityId },
      include: { roles: true, membership: true },
    });

    if (!member) {
      const decision: AccessDecision = {
        allowed: false,
        code: "DENY",
        reasons: [
          {
            code: "NOT_MEMBER",
            message: "Wallet is not a member of community",
          },
        ],
        membershipState: "invited",
        effectiveRoles: [],
      };
      await auditAccess({
        walletId: wallet,
        communityId,
        resource,
        policyRule: null,
        decision: "DENY",
        reasonCode: decision.reasons?.[0]?.code ?? null,
      });
      await cacheService.setJSON(cacheKey, decision, decisionTtlSeconds);
      return decision;
    }

    const policy = await prismaClient.accessPolicy.findFirst({
      where: { communityId, resource },
    });

    const ruleType = policy ? policy.ruleType : "MEMBERS_ONLY";

    const ctx: RoleContext = {
      assignments: member.roles.map((r) => ({
        role: r.role as any,
        source: r.source as any,
        active: r.active,
      })),
      membershipState: (member.membership?.state as any) ?? "invited",
    };

    const decision = evaluate(
      {
        id: policy?.id ?? "default",
        communityId,
        resource,
        ruleType,
        params: policy?.params as Record<string, any> | undefined,
      },
      ctx,
    );

    const reasonCode = decision.reasons?.[0]?.code ?? null;
    const allowedDecision = decision.allowed ? "ALLOW" : "DENY";

    await auditAccess({
      walletId: wallet,
      communityId,
      resource,
      policyRule: policy?.ruleType ?? null,
      decision: allowedDecision,
      reasonCode,
      details: (decision as any).details ?? null,
    });

    await cacheService.setJSON(cacheKey, decision, decisionTtlSeconds);

    return decision;
  }

  return {
    async getMembershipsByWallet(wallet: string) {
      const w = await prismaClient.wallet.findUnique({
        where: { address: normaliseWallet(wallet) },
      });
      if (!w) return { wallet, communities: [] };
      const members = await prismaClient.member.findMany({
        where: { walletId: w.id },
        include: { membership: true },
      });
      const communities = members.map((m) => ({
        communityId: m.communityId,
        state: m.membership?.state || "invited",
        expiresAt: m.membership?.expiresAt?.toISOString() ?? null,
      }));
      return { wallet, communities };
    },
    async getProfileByWallet(wallet: string) {
      const w = await prismaClient.wallet.findUnique({
        where: { address: normaliseWallet(wallet) },
      });
      if (!w) return null;
      const m = await prismaClient.member.findFirst({
        where: { walletId: w.id },
        include: { profile: true, membership: true, roles: true },
      });
      if (!m) return null;
      return {
        wallet,
        communityId: m.communityId,
        profile: {
          id: m.profile?.id ?? "",
          displayName: m.profile?.displayName ?? "",
          bio: m.profile?.bio ?? "",
        },
        membership: {
          state: m.membership?.state ?? "invited",
          expiresAt: m.membership?.expiresAt?.toISOString() ?? null,
        },
        roles: m.roles.filter((r) => r.active).map((r) => r.role),
      };
    },

    async checkAccess(input: AccessCheckInput): Promise<AccessDecision> {
      const wallet = input.wallet.toLowerCase();
      const w = await db.wallet.findUnique({ where: { address: wallet } });
      if (!w) {
        return {
          allowed: false,
          code: "DENY",
          reasons: [{ code: "NO_WALLET", message: "Wallet not known" }],
          membershipState: "invited",
          effectiveRoles: [],
        };
      }
      const member = await db.member.findFirst({
        where: { walletId: w.id, communityId: input.communityId },
        include: { roles: true, membership: true },
      });
      if (!member) {
        return {
          allowed: false,
          code: "DENY",
          reasons: [
            {
              code: "NOT_MEMBER",
              message: "Wallet is not a member of community",
            },
          ],
          membershipState: "invited",
          effectiveRoles: [],
        };
      }
      const policy = await db.accessPolicy.findFirst({
        where: { communityId: input.communityId, resource: input.resource },
      });
      const ruleType = policy ? policy.ruleType : "MEMBERS_ONLY";
      const ctx: RoleContext = {
        assignments: member.roles.map((r) => ({
          role: r.role as any,
          source: r.source as any,
          active: r.active,
        })),
        membershipState: (member.membership?.state as any) ?? "invited",
      };
      const decision = evaluate(
        {
          id: policy?.id ?? "default",
          communityId: input.communityId,
          resource: input.resource,
          ruleType: ruleType,
          params: policy?.params as Record<string, any> | undefined,
        },
        ctx,
      );
      return decision;
    },
    async listMembersForAdmin(
      communityId: string,
      role?: "admin" | "member" | "contributor",
    ) {

      // TODO: add auth to ensure requester is admin
      const members = await db.member.findMany({
        where: { communityId },
        include: { wallet: true, membership: true, roles: true, profile: true },
      });
      const list = members
        .map((m) => {
          const activeRoles = m.roles
            .filter((r) => r.active)
            .map((r) => r.role);
          return {
            wallet: m.wallet.address,
            displayName: m.profile?.displayName ?? null,
            state: m.membership?.state ?? "invited",
            roles: activeRoles,
          };
        })
        .filter((item) => (role ? item.roles.includes(role) : true));
      return { communityId, members: list };
    },

    // Invalidation hooks (call from mutation/event handlers)
    bumpMembershipVersion,
    bumpRoleVersion,
    bumpPolicyVersion,
    bumpResourceVersion,
  };
}

export const memberService = getMemberService(prisma);

// Backwards-compatible re-export of the invalidation hooks.
// These are intended to be called by membership/role/policy mutation handlers.
export const bumpMembershipVersion = memberService.bumpMembershipVersion;
export const bumpRoleVersion = memberService.bumpRoleVersion;
export const bumpPolicyVersion = memberService.bumpPolicyVersion;
export const bumpResourceVersion = memberService.bumpResourceVersion;


