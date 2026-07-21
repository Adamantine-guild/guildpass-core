import { PrismaClient } from "@prisma/client";
import {
  AccessCheckInput,
  AccessDecision,
  AccessOverride,
  AccessOverrideMutationInput,
  AccessOverrideMutationResult,
  Role,
  RoleContext,
  AssignRoleInput,
  RemoveRoleInput,
  RoleMutationResult,
} from "@guildpass/shared-types";
import { evaluate } from "@guildpass/policy-engine";
import { logEvent } from "./auditService";
import { logOutboxEventTx } from "./outboxService";

import { config } from "../config";
import { createDefaultCacheService } from "./redisCacheService";
import type { CacheService } from "./cacheService";

const prisma = new PrismaClient();

export class MemberServiceError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.name = 'MemberServiceError';
    this.statusCode = statusCode;
  }
}

function normaliseWallet(wallet: string): string {
  return wallet.toLowerCase();
}

function getNormalizedMembershipState(
  state: string,
  expiresAt?: Date | null,
): string {
  if (expiresAt && new Date(expiresAt) < new Date()) {
    return "expired";
  }
  return state;
}

export function accessDecisionCacheKey({
  communityId,
  wallet,
  resource,
  membershipVersion,
  roleVersion,
  policyVersion,
  resourceVersion,
  overrideVersion,
}: {
  communityId: string;
  wallet: string;
  resource: string;
  membershipVersion: number | null;
  roleVersion: number | null;
  policyVersion: number | null;
  resourceVersion: number | null;
  overrideVersion: number | null;
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
    `ov:${overrideVersion ?? 0}`,
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
function overrideVersionKey(communityId: string) {
  return `accessDecisionVersion:override|c:${communityId}`;
}

export function getMemberService(prismaClient: PrismaClient) {
  const cacheService: CacheService = createDefaultCacheService(
    config.accessDecisionCacheEnabled,
    config.redisUrl,
  );

  const versionTtlSeconds = config.accessDecisionCacheVersionTtlSeconds;
  const decisionTtlSeconds = config.accessDecisionCacheTtlSeconds;

  async function getVersionedKeyParts(communityId: string) {
    const [membershipVersion, roleVersion, policyVersion, resourceVersion, overrideVersion] =
      await Promise.all([
        cacheService.getIncr(membershipVersionKey(communityId)),
        cacheService.getIncr(roleVersionKey(communityId)),
        cacheService.getIncr(policyVersionKey(communityId)),
        cacheService.getIncr(resourceVersionKey(communityId)),
        cacheService.getIncr(overrideVersionKey(communityId)),
      ]);

    return {
      membershipVersion,
      roleVersion,
      policyVersion,
      resourceVersion,
      overrideVersion,
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
  async function bumpOverrideVersion(communityId: string) {
    await cacheService.incr(overrideVersionKey(communityId), versionTtlSeconds);
  }

  async function auditAccess(input: {
    walletId?: string | null;
    communityId?: string | null;
    resource?: string | null;
    policyRule?: string | null;
    decision: "ALLOW" | "DENY";
    reasonCode?: string | null;
    details?: any;
    correlationId?: string | null;
    membershipState?: any;
    roleState?: any;
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
        correlationId: input.correlationId ?? null,
        membershipStateVersion: input.membershipState ? JSON.stringify(input.membershipState) : null,
        roleStateVersion: input.roleState ? JSON.stringify(input.roleState) : null,
        beforeState: null,
        afterState: { evaluation: input.details ?? null },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to log access audit event:", err);
    }
  }

  async function checkAccess(input: AccessCheckInput): Promise<AccessDecision> {
    const wallet = normaliseWallet(input.wallet);
    const communityId = input.communityId;
    const resource = input.resource;

    // Generate correlation ID for this access check
    const correlationId = `access_${communityId}_${wallet}_${resource}_${Date.now()}`;

    const versions = await getVersionedKeyParts(communityId);
    const cacheKey = accessDecisionCacheKey({
      communityId,
      wallet,
      resource,
      ...versions,
    });

    const cached = await cacheService.getJSON<any>(cacheKey);
    if (cached) return cached as unknown as AccessDecision;

    const policy = await prismaClient.accessPolicy.findFirst({
      where: { communityId, resource },
    });

    const ruleType = policy ? policy.ruleType : "MEMBERS_ONLY";
    const overrides = await prismaClient.accessOverride.findMany({
      where: { communityId, resource, wallet },
    });

    const basePolicy = {
      id: policy?.id ?? "default",
      communityId,
      resource,
      ruleType,
      params: policy?.params as Record<string, any> | undefined,
    };

    if (overrides.length > 0) {
      const ctx: RoleContext = {
        assignments: [],
        membershipState: "invited",
        wallet,
        communityId,
        resource,
        overrides: overrides.map((override: AccessOverride) => ({
          id: override.id,
          wallet: override.wallet,
          communityId: override.communityId,
          resource: override.resource,
          effect: override.effect as any,
          expiresAt: override.expiresAt,
          reason: override.reason,
        })),
      };
      const decision = evaluate(basePolicy, ctx);
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
        correlationId,
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
        correlationId,
      });
      await cacheService.setJSON(cacheKey, decision, decisionTtlSeconds);
      return decision;
    }

    const effectiveState = getNormalizedMembershipState(
      (member.membership?.state as any) ?? "invited",
      member.membership?.expiresAt,
    );

    // Capture state snapshot for audit trail
    const membershipStateSnapshot = member.membership ? {
      id: member.membership.id,
      tokenId: member.membership.tokenId,
      state: member.membership.state,
      expiresAt: member.membership.expiresAt?.toISOString(),
      effectiveState,
    } : null;

    const roleStateSnapshot = member.roles.map((r) => ({
      id: r.id,
      role: r.role,
      source: r.source,
      active: r.active,
      expiresAt: r.expiresAt?.toISOString(),
    }));

    const ctx: RoleContext = {
      assignments: member.roles.map((r) => ({
        role: r.role as any,
        source: r.source as any,
        active: r.active,
        expiresAt: r.expiresAt,
      })),
      membershipState: effectiveState as any,
      wallet,
      communityId,
      resource,
      overrides: overrides.map((override: AccessOverride) => ({
        id: override.id,
        wallet: override.wallet,
        communityId: override.communityId,
        resource: override.resource,
        effect: override.effect as any,
        expiresAt: override.expiresAt,
        reason: override.reason,
      })),
    };

    const decision = evaluate(basePolicy, ctx);

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
      correlationId,
      membershipState: membershipStateSnapshot,
      roleState: roleStateSnapshot,
    });

    await cacheService.setJSON(cacheKey, decision, decisionTtlSeconds);

    return decision;
  }

  return {
    async getMembershipsByWallet(wallet: string, communityId?: string) {
      const w = await prismaClient.wallet.findUnique({
        where: { address: normaliseWallet(wallet) },
      });
      if (!w) return { wallet, communities: [] };
      const members = await prismaClient.member.findMany({
        where: { walletId: w.id, ...(communityId ? { communityId } : {}) },
        include: { membership: true },
      });
      const communities = members.map((m: any) => ({
        communityId: m.communityId,
        state: getNormalizedMembershipState(
          m.membership?.state || "invited",
          m.membership?.expiresAt,
        ),
        expiresAt: m.membership?.expiresAt?.toISOString() ?? null,
      }));
      return { wallet: normaliseWallet(wallet), communities };
    },
    async getProfileByWallet(wallet: string, communityId?: string) {
      const normalised = normaliseWallet(wallet);
      const w = await prismaClient.wallet.findUnique({
        where: { address: normalised },
      });
      if (!w) return null;
      const m = await prismaClient.member.findFirst({
        where: { walletId: w.id, ...(communityId ? { communityId } : {}) },
        include: { profile: true, membership: true, roles: true },
      });
      if (!m) return null;
      return {
        wallet: normalised,
        communityId: m.communityId,
        profile: {
          id: m.profile?.id ?? "",
          displayName: m.profile?.displayName ?? "",
          bio: m.profile?.bio ?? "",
        },
        membership: {
          state: getNormalizedMembershipState(
            m.membership?.state ?? "invited",
            m.membership?.expiresAt,
          ),
          expiresAt: m.membership?.expiresAt?.toISOString() ?? null,
        },
        roles: m.roles.filter((r: any) => r.active).map((r: any) => r.role),
      };
    },

    checkAccess,

    async listMembersForAdmin(
      communityId: string,
      role?: Role,
    ) {
      const members = await prismaClient.member.findMany({
        where: { communityId },
        include: { wallet: true, membership: true, roles: true, profile: true },
      });
      const list = members
        .map((m: any) => {
          const activeRoles = m.roles
            .filter((r: any) => r.active)
            .map((r: any) => r.role);
          return {
            wallet: m.wallet.address,
            displayName: m.profile?.displayName ?? null,
            state: getNormalizedMembershipState(
              m.membership?.state ?? "invited",
              m.membership?.expiresAt,
            ),
            roles: activeRoles,
          };
        })
        .filter((item: any) => (role ? item.roles.includes(role) : true));
      return { communityId, members: list };
    },

    async assignMemberRole(input: AssignRoleInput): Promise<RoleMutationResult> {
      const { requesterWallet, communityId, targetWallet, role } = input;
      const validRoles: Role[] = ["admin", "member", "contributor"];
      if (!validRoles.includes(role)) {
        throw { statusCode: 400, message: "Invalid role" };
      }

      const requester = await prismaClient.wallet.findUnique({
        where: { address: normaliseWallet(requesterWallet) },
      });
      if (!requester) throw { statusCode: 403, message: "Requester not found" };

      const requesterMember = await prismaClient.member.findFirst({
        where: { walletId: requester.id, communityId },
        include: { roles: true },
      });
      const isRequesterAdmin = requesterMember?.roles.some(
        (r) => r.role === "admin" && r.active,
      );
      if (!isRequesterAdmin) throw { statusCode: 403, message: "Not authorized" };

      const target = await prismaClient.wallet.findUnique({
        where: { address: normaliseWallet(targetWallet) },
      });
      if (!target) throw { statusCode: 404, message: "Target wallet not found" };

      const targetMember = await prismaClient.member.findFirst({
        where: { walletId: target.id, communityId },
      });
      if (!targetMember) throw { statusCode: 404, message: "Target not a member" };

      const existing = await prismaClient.roleAssignment.findFirst({
        where: { memberId: targetMember.id, role, active: true },
      });
      if (existing) {
        return { communityId, wallet: targetWallet, role, assigned: false, removed: false, message: "Role already assigned" };
      }

      await prismaClient.roleAssignment.create({
        data: {
          memberId: targetMember.id,
          role,
          source: "manual",
          active: true,
        },
      });

      await bumpRoleVersion(communityId);
      return { communityId, wallet: targetWallet, role, assigned: true, removed: false };
    },

    async createAccessOverride(input: AccessOverrideMutationInput): Promise<AccessOverrideMutationResult> {
      const {
        requesterWallet,
        communityId,
        wallet,
        resource,
        effect,
        reason,
        expiresAt,
      } = input;
      const normalizedWallet = normaliseWallet(wallet);
      const normalizedRequesterWallet = normaliseWallet(requesterWallet);
      if (!normalizedWallet || !resource || !["ALLOW", "DENY"].includes(effect)) {
        throw { statusCode: 400, message: "Invalid override payload" };
      }

      const requester = await prismaClient.wallet.findUnique({
        where: { address: normalizedRequesterWallet },
      });
      if (!requester) throw { statusCode: 403, message: "Requester not found" };

      const requesterMember = await prismaClient.member.findFirst({
        where: { walletId: requester.id, communityId },
        include: { roles: true },
      });
      const isRequesterAdmin = requesterMember?.roles.some(
        (r) => r.role === "admin" && r.active,
      );
      if (!isRequesterAdmin) throw { statusCode: 403, message: "Not authorized" };

      const parsedExpiresAt = expiresAt ? new Date(expiresAt) : null;
      const result = await prismaClient.$transaction(async (tx: any) => {
        const existing = await tx.accessOverride.findFirst({
          where: { communityId, wallet: normalizedWallet, resource },
        });

        let overrideRecord: any;
        if (existing) {
          overrideRecord = await tx.accessOverride.update({
            where: { id: existing.id },
            data: {
              effect,
              reason: reason ?? null,
              expiresAt: parsedExpiresAt,
            },
          });
        } else {
          overrideRecord = await tx.accessOverride.create({
            data: {
              wallet: normalizedWallet,
              communityId,
              resource,
              effect,
              reason: reason ?? null,
              expiresAt: parsedExpiresAt,
            },
          });
        }

        await logOutboxEventTx(tx, {
          eventType: "ACCESS_OVERRIDE_CREATED",
          entityId: overrideRecord.id,
          entityType: "AccessOverride",
          communityId,
          payload: {
            wallet: normalizedWallet,
            resource,
            effect,
            reason: reason ?? null,
            expiresAt: parsedExpiresAt?.toISOString() ?? null,
          },
        });

        return overrideRecord;
      });

      await bumpOverrideVersion(communityId);
      return {
        communityId,
        wallet: normalizedWallet as any,
        resource,
        effect,
        created: true,
        removed: false,
      };
    },

    async revokeAccessOverride(input: AccessOverrideMutationInput): Promise<AccessOverrideMutationResult> {
      const { requesterWallet, communityId, wallet, resource } = input;
      const normalizedWallet = normaliseWallet(wallet);
      const normalizedRequesterWallet = normaliseWallet(requesterWallet);
      if (!normalizedWallet || !resource) {
        throw { statusCode: 400, message: "Invalid revoke payload" };
      }

      const requester = await prismaClient.wallet.findUnique({
        where: { address: normalizedRequesterWallet },
      });
      if (!requester) throw { statusCode: 403, message: "Requester not found" };

      const requesterMember = await prismaClient.member.findFirst({
        where: { walletId: requester.id, communityId },
        include: { roles: true },
      });
      const isRequesterAdmin = requesterMember?.roles.some(
        (r) => r.role === "admin" && r.active,
      );
      if (!isRequesterAdmin) throw { statusCode: 403, message: "Not authorized" };

      const existing = await prismaClient.accessOverride.findFirst({
        where: { communityId, wallet: normalizedWallet, resource },
      });
      if (!existing) {
        return { communityId, wallet: normalizedWallet as any, resource, effect: "DENY", created: false, removed: false, message: "Override not found" };
      }

      await prismaClient.$transaction(async (tx: any) => {
        await tx.accessOverride.delete({ where: { id: existing.id } });
        await logOutboxEventTx(tx, {
          eventType: "ACCESS_OVERRIDE_REVOKED",
          entityId: existing.id,
          entityType: "AccessOverride",
          communityId,
          payload: {
            wallet: normalizedWallet,
            resource,
          },
        });
      });

      await bumpOverrideVersion(communityId);
      return { communityId, wallet: normalizedWallet as any, resource, effect: "DENY", created: false, removed: true };
    },

    async removeMemberRole(input: RemoveRoleInput): Promise<RoleMutationResult> {
      const { requesterWallet, communityId, targetWallet, role } = input;

      const requester = await prismaClient.wallet.findUnique({
        where: { address: normaliseWallet(requesterWallet) },
      });
      if (!requester) throw { statusCode: 403, message: "Requester not found" };

      const requesterMember = await prismaClient.member.findFirst({
        where: { walletId: requester.id, communityId },
        include: { roles: true },
      });
      const isRequesterAdmin = requesterMember?.roles.some(
        (r) => r.role === "admin" && r.active,
      );
      if (!isRequesterAdmin) throw { statusCode: 403, message: "Not authorized" };

      const target = await prismaClient.wallet.findUnique({
        where: { address: normaliseWallet(targetWallet) },
      });
      if (!target) throw { statusCode: 404, message: "Target wallet not found" };

      const targetMember = await prismaClient.member.findFirst({
        where: { walletId: target.id, communityId },
      });
      if (!targetMember) throw { statusCode: 404, message: "Target not a member" };

      await prismaClient.roleAssignment.updateMany({
        where: { memberId: targetMember.id, role, active: true },
        data: { active: false },
      });

      await bumpRoleVersion(communityId);
      return { communityId, wallet: targetWallet, role, assigned: false, removed: true };
    },

    bumpMembershipVersion,
    bumpRoleVersion,
    bumpPolicyVersion,
    bumpResourceVersion,
    bumpOverrideVersion,
  };
}

export const memberService = getMemberService(prisma);

export const bumpMembershipVersion = memberService.bumpMembershipVersion;
export const bumpRoleVersion = memberService.bumpRoleVersion;
export const bumpPolicyVersion = memberService.bumpPolicyVersion;
export const bumpResourceVersion = memberService.bumpResourceVersion;
export const bumpOverrideVersion = memberService.bumpOverrideVersion;
