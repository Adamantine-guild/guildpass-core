import { PrismaClient } from "@prisma/client";
import {
  AccessCheckInput,
  AccessDecision,
  AccessOverride,
  AccessPolicy,
  AccessOverrideMutationInput,
  AccessOverrideMutationResult,
  Role,
  RoleContext,
  AssignRoleInput,
  RemoveRoleInput,
  RoleMutationResult,
  AssignBadgeInput,
  RevokeBadgeInput,
  BadgeMutationResult,
  ListBadgesResult,
  WalletAddress,
  RoleDefinition,
  DelegatedGrant,
} from "@guildpass/shared-types";
import {
  createDefaultEngine,
  resolveConflicts,
  resolveEffectiveRoles,
  DEFAULT_RESOLUTION_CONFIG,
  type EvaluationResult,
} from "@guildpass/policy-engine";
import type { ContributionScore } from "@guildpass/governance-engine";
import {
  GovernanceRuleProvider,
  type ActiveGovernanceRule,
} from "../policy/governanceRuleProvider";
import { logEvent } from "./auditService";
import { logOutboxEventTx } from "./outboxService";
import { getIdentityService } from "./identityService";
import { validateAndEvaluateMutation } from "./constitutionalService";

import { config } from "../config";
import { createDefaultCacheService } from "./redisCacheService";
import type { CacheService } from "./cacheService";

const prisma = new PrismaClient();
const policyEngine = createDefaultEngine();

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
  delegationVersion,
}: {
  communityId: string;
  wallet: string;
  resource: string;
  membershipVersion: number | null;
  roleVersion: number | null;
  policyVersion: number | null;
  resourceVersion: number | null;
  overrideVersion: number | null;
  delegationVersion?: number | null;
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
    `dv:${delegationVersion ?? 0}`,
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
function delegationVersionKey(communityId: string) {
  return `accessDecisionVersion:delegation|c:${communityId}`;
}

async function loadActiveGovernanceRules(
  prismaClient: PrismaClient,
  communityId: string,
  resource: string,
): Promise<ActiveGovernanceRule[]> {
  const rules = await prismaClient.governanceRule.findMany({
    where: { communityId, resource, active: true },
  });
  return rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    resource: rule.resource,
    ast: rule.ast as unknown as ActiveGovernanceRule["ast"],
  }));
}

async function loadContributionScore(
  prismaClient: PrismaClient,
  wallet: string,
  communityId: string,
): Promise<ContributionScore | undefined> {
  const score = await prismaClient.contributionScore.findUnique({
    where: { walletId_communityId: { walletId: wallet, communityId } },
  });
  if (!score) return undefined;
  return {
    total: score.totalScore,
    breakdown: (score.breakdown as ContributionScore["breakdown"]) ?? {},
  };
}

function applyGovernanceDecision(
  base: AccessDecision,
  ctx: RoleContext,
  basePolicy: AccessPolicy,
  opts: {
    rules: ActiveGovernanceRule[];
    wallet: string;
    communityId: string;
    contributionScore?: ContributionScore;
  },
): AccessDecision {
  const provider = new GovernanceRuleProvider(opts);
  const effectiveRoles = (base.effectiveRoles ?? resolveEffectiveRoles(ctx)) as Role[];
  const govResult = provider.evaluate({
    policy: basePolicy,
    roleContext: ctx,
    effectiveRoles,
  });

  if (govResult.result === "ABSTAIN") {
    return base;
  }

  const baseResult: EvaluationResult = {
    result: base.code,
    explanation: base.reasons.map((r) => r.message).join("; "),
    code: base.reasons[0]?.code,
  };

  const resolution = resolveConflicts(
    [baseResult, govResult],
    DEFAULT_RESOLUTION_CONFIG,
  );

  return {
    allowed: resolution.decision === "ALLOW",
    code: resolution.decision,
    reasons: [
      ...base.reasons,
      {
        code: govResult.code ?? `GOVERNANCE_${govResult.result}`,
        message: govResult.explanation,
      },
    ],
    effectiveRoles,
    membershipState: base.membershipState,
  };
}

export function getMemberService(prismaClient: PrismaClient) {
  const cacheService: CacheService = createDefaultCacheService(
    config.accessDecisionCacheEnabled,
    config.redisUrl,
  );
  const identityService = getIdentityService(prismaClient);

  const versionTtlSeconds = config.accessDecisionCacheVersionTtlSeconds;
  const decisionTtlSeconds = config.accessDecisionCacheTtlSeconds;

  async function getVersionedKeyParts(communityId: string) {
    const [membershipVersion, roleVersion, policyVersion, resourceVersion, overrideVersion, delegationVersion] =
      await Promise.all([
        cacheService.getIncr(membershipVersionKey(communityId)),
        cacheService.getIncr(roleVersionKey(communityId)),
        cacheService.getIncr(policyVersionKey(communityId)),
        cacheService.getIncr(resourceVersionKey(communityId)),
        cacheService.getIncr(overrideVersionKey(communityId)),
        cacheService.getIncr(delegationVersionKey(communityId)),
      ]);

    return {
      membershipVersion,
      roleVersion,
      policyVersion,
      resourceVersion,
      overrideVersion,
      delegationVersion,
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
  async function bumpDelegationVersion(communityId: string) {
    await cacheService.incr(delegationVersionKey(communityId), versionTtlSeconds);
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

    // Get primary wallet and all linked wallets
    const primaryWallet = await identityService.getPrimaryWallet(wallet as WalletAddress);
    const allLinkedWallets = await identityService.getLinkedWallets(primaryWallet);

    // Generate correlation ID for this access check
    const correlationId = `access_${communityId}_${wallet}_${resource}_${Date.now()}`;

    const versions = await getVersionedKeyParts(communityId);
    const cacheKey = accessDecisionCacheKey({
      communityId,
      wallet: primaryWallet,
      resource,
      ...versions,
    });

    const cached = await cacheService.getJSON<any>(cacheKey);
    if (cached) return cached as unknown as AccessDecision;

    // Aggregate state from ALL linked wallets (primary + secondaries)
    // 1. Get all wallets
    let wallets = await prismaClient.wallet.findMany({
      where: {
        address: { in: allLinkedWallets.map(normaliseWallet) },
      },
    });

    if ((!wallets || wallets.length === 0) && allLinkedWallets.length > 0) {
      wallets = [];
      for (const addr of allLinkedWallets) {
        const w = await prismaClient.wallet.findUnique({
          where: { address: addr.toLowerCase() },
        });
        if (w) {
          wallets.push(w);
        }
      }
    }

    // 2. Get all members for these wallets in the community
    let members = await prismaClient.member.findMany({
      where: {
        walletId: { in: wallets.map(w => w.id) },
        communityId,
      },
      include: {
        roles: true,
        membership: {
          include: {
            activeToken: true,
          },
        },
      },
    });

    if ((!members || members.length === 0) && wallets.length > 0) {
      for (const w of wallets) {
        const m = await prismaClient.member.findFirst({
          where: { walletId: w.id, communityId },
          include: {
            roles: true,
            membership: {
              include: {
                activeToken: true,
              },
            },
          },
        });
        if (m) {
          members.push(m);
        }
      }
    }

    // Aggregate roles: union of all roles from all members
    const allAssignments = members.flatMap(member =>
      (member.roles || []).map(role => ({
        role: role.role as Role,
        source: role.source as "manual" | "auto",
        active: role.active,
        expiresAt: role.expiresAt,
      }))
    );

    // Aggregate membership state: if ANY member has active membership, state is active
    let membershipState: "invited" | "active" | "expired" | "suspended" = "invited";
    let activeTokenId: number | null = null;
    let rawState: string | null = null;
    for (const member of members) {
      const activeToken = member.membership?.activeToken;
      const legacyState = (member.membership as any)?.state;
      const legacyExpiresAt = (member.membership as any)?.expiresAt;
      const stateVal = activeToken?.state ?? legacyState;
      if (!stateVal) continue;
      const expiresAtVal = activeToken ? activeToken.expiresAt : (legacyExpiresAt ?? null);

      const state = getNormalizedMembershipState(
        stateVal as any,
        expiresAtVal,
      );
      if (state === "active") {
        membershipState = "active";
        activeTokenId = activeToken?.tokenId ?? null;
        rawState = stateVal;
        break; // No need to check further if we have an active one
      }
      if (state === "suspended") {
        membershipState = "suspended";
        activeTokenId = activeToken?.tokenId ?? null;
        rawState = stateVal;
      }
      if (state === "expired" && membershipState !== "suspended") {
        membershipState = "expired";
        activeTokenId = activeToken?.tokenId ?? null;
        rawState = stateVal;
      }
    }

    const auditMembershipSnapshot = activeTokenId ? {
      tokenId: activeTokenId,
      state: rawState,
      effectiveState: membershipState,
    } : {
      state: "invited",
      effectiveState: "invited",
    };

    const policy = await prismaClient.accessPolicy.findFirst({
      where: { communityId, resource },
    });

    if (!policy) {
      return {
        allowed: false,
        code: "DENY",
        reasons: [
          {
            code: "NO_POLICY",
            message: "No access policy found for this resource",
          },
        ],
        effectiveRoles: [],
        membershipState,
      };
    }

    const ruleType = policy.ruleType;
    const basePolicy = {
      id: policy.id,
      communityId,
      resource,
      ruleType,
      params: policy.params as Record<string, any> | undefined,
    };

    // Fetch all role definitions and delegated grants for the community and wallet
    const rawRoleDefinitions = await prismaClient.roleDefinition.findMany({
      where: { communityId },
    });
    const roleDefinitions: RoleDefinition[] = rawRoleDefinitions.map(def => ({
      id: def.id,
      communityId: def.communityId,
      name: def.name,
      description: def.description,
      parentRoleId: def.parentRoleId,
      builtInRole: def.builtInRole as Role | null,
      createdAt: def.createdAt.toISOString(),
      updatedAt: def.updatedAt.toISOString(),
    }));

    const rawDelegatedGrants = await prismaClient.delegatedGrant.findMany({
      where: {
        communityId,
        granteeWalletId: { in: wallets.map(w => w.id) },
      },
    });
    const delegatedGrants: DelegatedGrant[] = rawDelegatedGrants.map(grant => ({
      id: grant.id,
      communityId: grant.communityId,
      granterWalletId: grant.granterWalletId,
      granteeWalletId: grant.granteeWalletId,
      roles: grant.roles as Role[],
      scope: grant.scope as Record<string, any> | null,
      createdAt: grant.createdAt.toISOString(),
      expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
      revokedAt: grant.revokedAt ? grant.revokedAt.toISOString() : null,
      revokedBy: grant.revokedBy,
    }));

    // 3. Get all overrides that apply to any of these wallets
    const overrides = await prismaClient.accessOverride.findMany({
      where: {
        communityId,
        resource,
        wallet: { in: allLinkedWallets.map(normaliseWallet) },
      },
    });

    // If there are any overrides, they take precedence (policy engine handles this)
    if (overrides.length > 0) {
      // Find the most permissive or first applicable override (policy engine uses first one)
      const ctx: RoleContext = {
        assignments: allAssignments,
        membershipState: membershipState,
        wallet: primaryWallet,
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
      const decision = policyEngine.evaluate(basePolicy, ctx, {
        roleDefinitions,
        delegatedGrants,
      });
      const reasonCode = decision.reasons?.[0]?.code ?? null;
      const allowedDecision = decision.allowed ? "ALLOW" : "DENY";
      await auditAccess({
        walletId: primaryWallet,
        communityId,
        resource,
        policyRule: policy?.ruleType ?? null,
        decision: allowedDecision,
        reasonCode,
        details: (decision as any).details ?? null,
        correlationId,
        membershipState: auditMembershipSnapshot,
        roleState: allAssignments,
      });
      await cacheService.setJSON(cacheKey, decision, decisionTtlSeconds);
      return decision;
    }

    const ctx: RoleContext = {
      assignments: allAssignments,
      membershipState,
      wallet: primaryWallet,
      communityId,
      resource,
      overrides: [],
    };

    let decision = policyEngine.evaluate(basePolicy, ctx, {
      roleDefinitions,
      delegatedGrants,
    });

    const governanceRules = await loadActiveGovernanceRules(
      prismaClient,
      communityId,
      resource,
    );
    if (governanceRules.length > 0) {
      const contributionScore = await loadContributionScore(
        prismaClient,
        primaryWallet,
        communityId,
      );
      decision = applyGovernanceDecision(decision, ctx, basePolicy, {
        rules: governanceRules,
        wallet: primaryWallet,
        communityId,
        contributionScore,
      });
    }

    const reasonCode = decision.reasons?.[0]?.code ?? null;
    const allowedDecision = decision.allowed ? "ALLOW" : "DENY";

    await auditAccess({
      walletId: primaryWallet,
      communityId,
      resource,
      policyRule: policy?.ruleType ?? null,
      decision: allowedDecision,
      reasonCode,
      details: (decision as any).details ?? null,
      correlationId,
      membershipState: auditMembershipSnapshot,
      roleState: allAssignments,
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
        include: {
          membership: {
            include: {
              activeToken: true,
            },
          },
        },
      });
      const communities = members.map((m: any) => {
        const activeToken = m.membership?.activeToken;
        const legacyState = (m.membership as any)?.state;
        const legacyExpiresAt = (m.membership as any)?.expiresAt;
        const stateVal = activeToken?.state ?? legacyState ?? "invited";
        const expiresAtVal = activeToken ? activeToken.expiresAt : (legacyExpiresAt ?? null);
        return {
          communityId: m.communityId,
          state: getNormalizedMembershipState(
            stateVal,
            expiresAtVal,
          ),
          expiresAt: expiresAtVal?.toISOString() ?? null,
        };
      });
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
        include: {
          profile: true,
          membership: {
            include: {
              activeToken: true,
            },
          },
          roles: true,
        },
      });
      if (!m) return null;
      const activeToken = m.membership?.activeToken;
      const legacyState = (m.membership as any)?.state;
      const legacyExpiresAt = (m.membership as any)?.expiresAt;
      const stateVal = activeToken?.state ?? legacyState ?? "invited";
      const expiresAtVal = activeToken ? activeToken.expiresAt : (legacyExpiresAt ?? null);
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
            stateVal,
            expiresAtVal,
          ),
          expiresAt: expiresAtVal?.toISOString() ?? null,
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
        include: {
          wallet: true,
          membership: {
            include: {
              activeToken: true,
            },
          },
          roles: true,
          profile: true,
        },
      });
      const list = members
        .map((m: any) => {
          const activeRoles = m.roles
            .filter((r: any) => r.active)
            .map((r: any) => r.role);
          const activeToken = m.membership?.activeToken;
          const legacyState = (m.membership as any)?.state;
          const legacyExpiresAt = (m.membership as any)?.expiresAt;
          const stateVal = activeToken?.state ?? legacyState ?? "invited";
          const expiresAtVal = activeToken ? activeToken.expiresAt : (legacyExpiresAt ?? null);
          return {
            wallet: m.wallet.address,
            displayName: m.profile?.displayName ?? null,
            state: getNormalizedMembershipState(
              stateVal,
              expiresAtVal,
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

      await prismaClient.$transaction(async (tx: any) => {
        await validateAndEvaluateMutation(tx, {
          action: "ROLE_ASSIGNMENT",
          communityId,
          actorWallet: requesterWallet,
          targetWallet,
          proposedData: { role },
        });

        await tx.roleAssignment.create({
          data: {
            memberId: targetMember.id,
            role,
            source: "manual",
            active: true,
          },
        });
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
      const { wasExisting } = await prismaClient.$transaction(async (tx: any) => {
        await validateAndEvaluateMutation(tx, {
          action: "OVERRIDE_CREATE",
          communityId,
          actorWallet: requesterWallet,
          targetWallet: normalizedWallet,
          targetResource: resource,
          proposedData: { effect, reason, expiresAt },
        });

        const existing = await tx.accessOverride.findFirst({
          where: { communityId, wallet: normalizedWallet, resource },
        });

        let record: any;
        if (existing) {
          record = await tx.accessOverride.update({
            where: { id: existing.id },
            data: {
              effect,
              reason: reason ?? null,
              expiresAt: parsedExpiresAt,
            },
          });
        } else {
          record = await tx.accessOverride.create({
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
          eventType: existing ? "ACCESS_OVERRIDE_UPDATED" : "ACCESS_OVERRIDE_CREATED",
          entityId: record.id,
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

        return { overrideRecord: record, wasExisting: !!existing };
      });

      await bumpOverrideVersion(communityId);
      return {
        communityId,
        wallet: normalizedWallet as any,
        resource,
        effect,
        created: !wasExisting,
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
        await validateAndEvaluateMutation(tx, {
          action: "OVERRIDE_REVOKE",
          communityId,
          actorWallet: requesterWallet,
          targetWallet: normalizedWallet,
          targetResource: resource,
        });

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

    async listAccessOverrides(
      communityId: string,
      requesterWallet: string,
    ): Promise<{
      communityId: string;
      overrides: Array<{
        wallet: string;
        resource: string;
        effect: "ALLOW" | "DENY";
        reason: string | null;
        expiresAt: string | null;
        expired: boolean;
        createdAt: string;
      }>;
    }> {
      const normalizedRequesterWallet = normaliseWallet(requesterWallet);
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

      const overrides = await prismaClient.accessOverride.findMany({
        where: { communityId },
        orderBy: { createdAt: "desc" },
      });

      const now = Date.now();
      return {
        communityId,
        overrides: overrides.map((o: any) => ({
          wallet: o.wallet,
          resource: o.resource,
          effect: o.effect as "ALLOW" | "DENY",
          reason: o.reason ?? null,
          expiresAt: o.expiresAt ? o.expiresAt.toISOString() : null,
          expired: !!o.expiresAt && o.expiresAt.getTime() < now,
          createdAt: o.createdAt.toISOString(),
        })),
      };
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

    async assignBadge(input: AssignBadgeInput): Promise<BadgeMutationResult> {
      const { requesterWallet, communityId, targetWallet, label } = input;
      if (!label || !label.trim()) {
        throw new MemberServiceError("Badge label is required", 400);
      }

      const requester = await prismaClient.wallet.findUnique({
        where: { address: normaliseWallet(requesterWallet) },
      });
      if (!requester) throw new MemberServiceError("Requester not found", 403);

      const requesterMember = await prismaClient.member.findFirst({
        where: { walletId: requester.id, communityId },
        include: { roles: true },
      });
      const isRequesterAdmin = requesterMember?.roles.some(
        (r) => r.role === "admin" && r.active,
      );
      if (!isRequesterAdmin) throw new MemberServiceError("Not authorized", 403);

      const target = await prismaClient.wallet.findUnique({
        where: { address: normaliseWallet(targetWallet) },
      });
      if (!target) throw new MemberServiceError("Target wallet not found", 404);

      const targetMember = await prismaClient.member.findFirst({
        where: { walletId: target.id, communityId },
      });
      if (!targetMember) throw new MemberServiceError("Target not a member", 404);

      const badge = await prismaClient.$transaction(async (tx: any) => {
        const created = await tx.badge.create({
          data: {
            memberId: targetMember.id,
            label,
          },
        });

        await logOutboxEventTx(tx, {
          eventType: "BADGE_ASSIGNED",
          entityId: created.id,
          entityType: "Badge",
          communityId,
          payload: {
            wallet: normaliseWallet(targetWallet),
            label: created.label,
          },
        });

        return created;
      });

      return {
        communityId,
        wallet: targetWallet,
        badge: {
          id: badge.id,
          memberId: badge.memberId,
          label: badge.label,
          issuedAt: badge.issuedAt.toISOString(),
        },
        assigned: true,
        removed: false,
      };
    },

    async revokeBadge(input: RevokeBadgeInput): Promise<BadgeMutationResult> {
      const { requesterWallet, communityId, targetWallet, badgeId } = input;

      const requester = await prismaClient.wallet.findUnique({
        where: { address: normaliseWallet(requesterWallet) },
      });
      if (!requester) throw new MemberServiceError("Requester not found", 403);

      const requesterMember = await prismaClient.member.findFirst({
        where: { walletId: requester.id, communityId },
        include: { roles: true },
      });
      const isRequesterAdmin = requesterMember?.roles.some(
        (r) => r.role === "admin" && r.active,
      );
      if (!isRequesterAdmin) throw new MemberServiceError("Not authorized", 403);

      const target = await prismaClient.wallet.findUnique({
        where: { address: normaliseWallet(targetWallet) },
      });
      if (!target) throw new MemberServiceError("Target wallet not found", 404);

      const targetMember = await prismaClient.member.findFirst({
        where: { walletId: target.id, communityId },
      });
      if (!targetMember) throw new MemberServiceError("Target not a member", 404);

      const existing = await prismaClient.badge.findFirst({
        where: { id: badgeId, memberId: targetMember.id },
      });
      if (!existing) {
        return { communityId, wallet: targetWallet, assigned: false, removed: false, message: "Badge not found" };
      }

      await prismaClient.$transaction(async (tx: any) => {
        await tx.badge.delete({ where: { id: existing.id } });
        await logOutboxEventTx(tx, {
          eventType: "BADGE_REVOKED",
          entityId: existing.id,
          entityType: "Badge",
          communityId,
          payload: {
            wallet: normaliseWallet(targetWallet),
            label: existing.label,
          },
        });
      });

      return { communityId, wallet: targetWallet, assigned: false, removed: true };
    },

    async listBadgesForMember(communityId: string, wallet: string): Promise<ListBadgesResult | null> {
      const target = await prismaClient.wallet.findUnique({
        where: { address: normaliseWallet(wallet) },
      });
      if (!target) return null;

      const targetMember = await prismaClient.member.findFirst({
        where: { walletId: target.id, communityId },
      });
      if (!targetMember) return null;

      const badges = await prismaClient.badge.findMany({
        where: { memberId: targetMember.id },
        orderBy: { issuedAt: "desc" },
      });

      return {
        communityId,
        wallet: wallet as WalletAddress,
        badges: badges.map((b) => ({
          id: b.id,
          memberId: b.memberId,
          label: b.label,
          issuedAt: b.issuedAt.toISOString(),
        })),
      };
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
