import { AccessDecision, AccessPolicy, RoleContext, AccessOverride, Role, RoleDefinition, DelegatedGrant } from "@guildpass/shared-types";
import { resolveEffectiveRoles as originalResolveEffectiveRoles } from "../src/roles";
import { createDefaultEngine } from "../src/engine";

// --- START OF COPY OF OLD MONOLITHIC EVALUATE ---
function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseWallet(value?: string): string | undefined {
  return value ? value.toLowerCase() : undefined;
}

function findActiveOverride(
  ctx: RoleContext,
  policy: AccessPolicy,
): AccessOverride | null {
  const wallet = normaliseWallet(ctx.wallet?.toString());
  const communityId = ctx.communityId ?? policy.communityId;
  const resource = ctx.resource ?? policy.resource;

  if (!wallet || !communityId || !resource) {
    return null;
  }

  const now = new Date();
  const overrides = ctx.overrides ?? [];

  for (const override of overrides) {
    const overrideWallet = normaliseWallet(override.wallet?.toString());
    if (!overrideWallet) continue;
    if (overrideWallet !== wallet) continue;
    if (override.communityId !== communityId) continue;
    if (override.resource !== resource) continue;
    if (override.expiresAt) {
      const expiry = new Date(override.expiresAt);
      if (expiry < now) continue;
    }
    return override;
  }

  return null;
}

function validatePolicy(
  policy: AccessPolicy,
): { valid: true } | { valid: false; message: string } {
  if (policy.params == null) {
    return { valid: true };
  }

  if (!isPlainObject(policy.params)) {
    return { valid: false, message: "Policy params must be a JSON object" };
  }

  return { valid: true };
}

// Simple rule evaluation mimicking the plugins for oldEvaluate
function evaluateRulePluginMock(policy: AccessPolicy, context: RoleContext, effectiveRoles: Role[]): AccessDecision {
  const initialReasons = [
    {
      code: `MEMBERSHIP_${context.membershipState.toUpperCase()}`,
      message: `Membership is ${context.membershipState}`,
    },
  ];

  const has = (role: string) => effectiveRoles.includes(role as any);

  if (policy.ruleType === 'PUBLIC') {
    return {
      allowed: true,
      code: 'ALLOW',
      reasons: [...initialReasons, { code: 'RULE_PUBLIC', message: 'Resource is public' }],
      effectiveRoles,
      membershipState: context.membershipState,
    };
  }

  if (policy.ruleType === 'MEMBERS_ONLY') {
    if (context.membershipState !== 'active') {
      return {
        allowed: false,
        code: 'DENY',
        reasons: [...initialReasons, { code: 'NEEDS_ACTIVE', message: 'Requires active membership' }],
        effectiveRoles,
        membershipState: context.membershipState,
      };
    }
    return {
      allowed: true,
      code: 'ALLOW',
      reasons: [...initialReasons, { code: 'HAS_ACTIVE_MEMBERSHIP', message: 'Active membership grants access' }],
      effectiveRoles,
      membershipState: context.membershipState,
    };
  }

  if (policy.ruleType === 'ADMINS_ONLY') {
    if (!has('admin')) {
      return {
        allowed: false,
        code: 'DENY',
        reasons: [...initialReasons, { code: 'NEEDS_ADMIN', message: 'Admin role required' }],
        effectiveRoles,
        membershipState: context.membershipState,
      };
    }
    return {
      allowed: true,
      code: 'ALLOW',
      reasons: [...initialReasons, { code: 'HAS_ADMIN', message: 'Admin role grants access' }],
      effectiveRoles,
      membershipState: context.membershipState,
    };
  }

  if (policy.ruleType === 'CONTRIBUTORS_OR_ADMINS') {
    if (has('admin') || has('contributor')) {
      return {
        allowed: true,
        code: 'ALLOW',
        reasons: [...initialReasons, { code: 'HAS_REQUIRED_ROLE', message: 'Contributor or admin grants access' }],
        effectiveRoles,
        membershipState: context.membershipState,
      };
    }
    return {
      allowed: false,
      code: 'DENY',
      reasons: [...initialReasons, { code: 'NEEDS_CONTRIBUTOR_OR_ADMIN', message: 'Contributor or admin required' }],
      effectiveRoles,
      membershipState: context.membershipState,
    };
  }

  // fallback/unhandled
  return {
    allowed: false,
    code: 'DENY',
    reasons: [...initialReasons, { code: 'RULE_UNHANDLED', message: `Unhandled or malformed policy rule: ${policy.ruleType}` }],
    effectiveRoles,
    membershipState: context.membershipState,
  };
}

function oldEvaluate(
  policy: AccessPolicy,
  ctx: RoleContext,
  options?: {
    roleDefinitions?: RoleDefinition[];
    delegatedGrants?: DelegatedGrant[];
  },
): AccessDecision {
  const effectiveRoles = originalResolveEffectiveRoles(ctx, {
    roleDefinitions: options?.roleDefinitions,
    delegatedGrants: options?.delegatedGrants,
  });

  const initialReasons = [
    {
      code: `MEMBERSHIP_${ctx.membershipState.toUpperCase()}`,
      message: `Membership is ${ctx.membershipState}`,
    },
  ];

  // Check access overrides first (highest priority)
  const override = findActiveOverride(ctx, policy);
  if (override) {
    const reasons = [...initialReasons];
    reasons.push({
      code: override.effect === "ALLOW" ? "OVERRIDE_ALLOW" : "OVERRIDE_DENY",
      message: override.reason
        ? `Override applied: ${override.reason}`
        : `Override applied as ${override.effect}`,
    });
    return {
      allowed: override.effect === "ALLOW",
      code: override.effect === "ALLOW" ? "ALLOW" : "DENY",
      reasons,
      effectiveRoles: effectiveRoles as Role[],
      membershipState: ctx.membershipState,
    };
  }

  // Validate policy
  const validation = validatePolicy(policy);
  if (!validation.valid) {
    const reasons = [...initialReasons];
    reasons.push({
      code: "MALFORMED_POLICY",
      message: `Malformed policy: ${validation.message}`,
    });
    return {
      allowed: false,
      code: "DENY",
      reasons,
      effectiveRoles: effectiveRoles as Role[],
      membershipState: ctx.membershipState,
    };
  }

  return evaluateRulePluginMock(policy, ctx, effectiveRoles as Role[]);
}
// --- END OF COPY OF OLD MONOLITHIC EVALUATE ---

describe("Policy Engine Parity Tests", () => {
  const ruleTypes = ["PUBLIC", "MEMBERS_ONLY", "ADMINS_ONLY", "CONTRIBUTORS_OR_ADMINS", "UNKNOWN_RULE"];
  const paramsList = [undefined, null, {}, { test: 123 }, "invalid_string"];
  const membershipStates = ["active", "invited", "expired", "suspended"];

  const assignmentsList = [
    [],
    [{ role: "admin" as Role, active: true, source: "manual" as const }],
    [{ role: "admin" as Role, active: false, source: "manual" as const }],
    [{ role: "admin" as Role, active: true, source: "manual" as const, expiresAt: new Date(Date.now() - 10000).toISOString() }],
    [{ role: "admin" as Role, active: true, source: "manual" as const, expiresAt: new Date(Date.now() + 10000).toISOString() }],
    [{ role: "contributor" as Role, active: true, source: "manual" as const }],
    [{ role: "member" as Role, active: true, source: "manual" as const }],
    [
      { role: "admin" as Role, active: true, source: "manual" as const },
      { role: "contributor" as Role, active: true, source: "manual" as const },
    ],
  ];

  const overridesList = [
    [],
    [{ wallet: "0xabc", communityId: "c1", resource: "res", effect: "ALLOW" as const, reason: "special permit" }],
    [{ wallet: "0xabc", communityId: "c1", resource: "res", effect: "DENY" as const, reason: "banned" }],
    [{ wallet: "0xabc", communityId: "c1", resource: "res", effect: "ALLOW" as const, expiresAt: new Date(Date.now() - 10000).toISOString() }],
    [{ wallet: "0xabc", communityId: "c1", resource: "res", effect: "ALLOW" as const, expiresAt: new Date(Date.now() + 10000).toISOString() }],
    [{ wallet: "0xother", communityId: "c1", resource: "res", effect: "ALLOW" as const }],
  ];

  const roleDefinitionsList = [
    undefined,
    [],
    [
      {
        id: "role-1",
        communityId: "c1",
        name: "CustomSuperAdmin",
        builtInRole: "admin" as Role,
        parentRoleId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  ];

  const delegatedGrantsList = [
    undefined,
    [],
    [
      {
        id: "grant-1",
        communityId: "c1",
        granterWalletId: "0xgranter",
        granteeWalletId: "0xabc",
        roles: ["admin" as Role],
        scope: null,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        revokedAt: null,
      },
    ],
  ];

  test("runs exhaustive parity check", () => {
    let count = 0;
    const engine = createDefaultEngine();

    for (const ruleType of ruleTypes) {
      for (const params of paramsList) {
        for (const membershipState of membershipStates) {
          for (const assignments of assignmentsList) {
            for (const overrides of overridesList) {
              for (const roleDefinitions of roleDefinitionsList) {
                for (const delegatedGrants of delegatedGrantsList) {
                  const policy: AccessPolicy = {
                    id: "policy-id",
                    communityId: "c1",
                    resource: "res",
                    ruleType,
                    params: params as any,
                  };

                  const ctx: RoleContext = {
                    wallet: "0xabc",
                    communityId: "c1",
                    resource: "res",
                    membershipState: membershipState as any,
                    assignments,
                    overrides,
                  };

                  const options = {
                    roleDefinitions,
                    delegatedGrants,
                  };

                  const oldResult = oldEvaluate(policy, ctx, options);
                  const newResult = engine.evaluate(policy, ctx, options);

                  expect(newResult.allowed).toBe(oldResult.allowed);
                  expect(newResult.code).toBe(oldResult.code);
                  expect(newResult.membershipState).toBe(oldResult.membershipState);
                  expect((newResult.effectiveRoles ?? []).sort()).toEqual((oldResult.effectiveRoles ?? []).sort());
                  expect(newResult.reasons).toEqual(oldResult.reasons);

                  count++;
                }
              }
            }
          }
        }
      }
    }

    console.log(`Successfully validated parity across ${count} scenarios!`);
  });
});
