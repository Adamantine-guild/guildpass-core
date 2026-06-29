import {
  AccessDecision,
  AccessPolicy,
  DecisionReason,
  RoleContext,
  Role,
  MembershipState,
} from "@guildpass/shared-types";

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  switch (policy.ruleType) {
    case "PUBLIC":
    case "MEMBERS_ONLY":
    case "ADMINS_ONLY":
    case "CONTRIBUTORS_OR_ADMINS":
      return { valid: true };
    default:
      return {
        valid: false,
        message: `Unhandled ruleType: ${policy.ruleType}`,
      };
  }
}

export function resolveEffectiveRoles(ctx: RoleContext): Role[] {
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

  if (ctx.membershipState === "active") {
    roles.push("member");
  }

  // Role hierarchy implementation:
  // admin -> contributor -> member
  const effective: Role[] = [...roles];
  if (roles.includes("admin")) {
    effective.push("contributor");
    effective.push("member");
  }
  if (roles.includes("contributor")) {
    effective.push("member");
  }

  return unique(effective);
}

export function evaluate(
  policy: AccessPolicy,
  ctx: RoleContext,
): AccessDecision {
  const roles = resolveEffectiveRoles(ctx);
  const reasons: DecisionReason[] = [];

  // Always record membership state as a reason context
  reasons.push({
    code: `MEMBERSHIP_${ctx.membershipState.toUpperCase()}`,
    message: `Membership is ${ctx.membershipState}`,
  });

  const validation = validatePolicy(policy);
  if (!validation.valid) {
    reasons.push({
      code: "MALFORMED_POLICY",
      message: `Malformed policy: ${validation.message}`,
    });
    return {
      allowed: false,
      code: "DENY",
      reasons,
      effectiveRoles: roles,
      membershipState: ctx.membershipState,
    };
  }

  const has = (r: Role) => roles.includes(r);

  switch (policy.ruleType) {
    case "PUBLIC":
      reasons.push({ code: "RULE_PUBLIC", message: "Resource is public" });
      return {
        allowed: true,
        code: "ALLOW",
        reasons,
        effectiveRoles: roles,
        membershipState: ctx.membershipState,
      };
    case "MEMBERS_ONLY":
      if (ctx.membershipState !== "active") {
        reasons.push({
          code: "NEEDS_ACTIVE",
          message: "Requires active membership",
        });
        return {
          allowed: false,
          code: "DENY",
          reasons,
          effectiveRoles: roles,
          membershipState: ctx.membershipState,
        };
      }
      reasons.push({
        code: "HAS_ACTIVE_MEMBERSHIP",
        message: "Active membership grants access",
      });
      return {
        allowed: true,
        code: "ALLOW",
        reasons,
        effectiveRoles: roles,
        membershipState: ctx.membershipState,
      };
    case "ADMINS_ONLY":
      if (!has("admin")) {
        reasons.push({ code: "NEEDS_ADMIN", message: "Admin role required" });
        return {
          allowed: false,
          code: "DENY",
          reasons,
          effectiveRoles: roles,
          membershipState: ctx.membershipState,
        };
      }
      reasons.push({ code: "HAS_ADMIN", message: "Admin role grants access" });
      return {
        allowed: true,
        code: "ALLOW",
        reasons,
        effectiveRoles: roles,
        membershipState: ctx.membershipState,
      };
    case "CONTRIBUTORS_OR_ADMINS":
      if (has("admin") || has("contributor")) {
        reasons.push({
          code: "HAS_REQUIRED_ROLE",
          message: "Contributor or admin grants access",
        });
        return {
          allowed: true,
          code: "ALLOW",
          reasons,
          effectiveRoles: roles,
          membershipState: ctx.membershipState,
        };
      }
      reasons.push({
        code: "NEEDS_CONTRIBUTOR_OR_ADMIN",
        message: "Contributor or admin required",
      });
      return {
        allowed: false,
        code: "DENY",
        reasons,
        effectiveRoles: roles,
        membershipState: ctx.membershipState,
      };
    default: {
      reasons.push({
        code: "RULE_UNHANDLED",
        message: `Unhandled or malformed policy rule: ${policy.ruleType}`,
      });
      return {
        allowed: false,
        code: "DENY",
        reasons,
        effectiveRoles: roles,
        membershipState: ctx.membershipState,
      };
    }
  }
}

export function explain(policy: AccessPolicy, ctx: RoleContext): string {
  const decision = evaluate(policy, ctx);
  const status = decision.allowed ? "ALLOWED" : "DENIED";
  const paramsString = policy.params
    ? ` params=${JSON.stringify(policy.params)}`
    : "";
  const lines = [
    `${status} for ruleType=${policy.ruleType}${paramsString}`,
    `roles=[${(decision.effectiveRoles || []).join(", ")}]`,
    ...decision.reasons.map((r) => `- ${r.code}: ${r.message}`),
  ];
  return lines.join("\n");
}
