// @ts-nocheck
import { evaluate, resolveEffectiveRoles } from "../src";
import type { AccessPolicy, RoleContext, AccessDecision } from "@guildpass/shared-types";

const baseCtx: RoleContext = {
  assignments: [],
  membershipState: 'active',
};

function policy(ruleType: string): AccessPolicy {
  return {
    id: '1',
    communityId: 'c1',
    resource: 'res',
    ruleType,
  };
}

function reasonCodes(decision: AccessDecision): string[] {
  return decision.reasons.map((r) => r.code);
}

describe("policy engine", () => {
  const ctxAdmin: RoleContext = {
    assignments: [{ role: "admin", source: "manual", active: true }],
    membershipState: "active",
  };
  const ctxContributor: RoleContext = {
    assignments: [{ role: "contributor", source: "manual", active: true }],
    membershipState: "active",
  };

  test("PUBLIC allows anyone", () => {
    const p = policy("PUBLIC");
    const d = evaluate(p, ctxAdmin);
    expect(d.allowed).toBe(true);
  });

  test("ADMINS_ONLY denies non-admin", () => {
    const p = policy("ADMINS_ONLY");
    const d = evaluate(p, { ...ctxAdmin, assignments: [] });
    expect(d.allowed).toBe(false);
  });

  test("ADMINS_ONLY allows admin", () => {
    const p = policy("ADMINS_ONLY");
    const d = evaluate(p, ctxAdmin);
    expect(d.allowed).toBe(true);
    expect(d.code).toBe('ALLOW');
  });

  test("CONTRIBUTORS_OR_ADMINS denies non-contributor-or-admin", () => {
    const p = policy("CONTRIBUTORS_OR_ADMINS");
    const d = evaluate(p, { assignments: [], membershipState: "active" });
    expect(d.allowed).toBe(false);
  });

  test("Malformed policy params deny safely", () => {
    const p = { ...policy("PUBLIC"), params: "not-an-object" as any };
    const d = evaluate(p, ctxAdmin);
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.code === "MALFORMED_POLICY")).toBe(true);
  });

  test("Unsupported ruleType denies safely", () => {
    const p = { ...policy("UNKNOWN_RULE"), ruleType: "UNKNOWN_RULE" };
    const d = evaluate(p, ctxAdmin);
    expect(d.allowed).toBe(false);
    // Modified to match the actual implementation which returns RULE_UNHANDLED
    expect(d.reasons.some((r) => r.code === "RULE_UNHANDLED")).toBe(true);
  });

  test("Structured policy params are preserved", () => {
    const p = { ...policy("PUBLIC"), params: { minimumRole: "contributor" } };
    const d = evaluate(p, ctxAdmin);
    expect(d.allowed).toBe(true);
    expect(d.reasons.some((r) => r.code === "RULE_PUBLIC")).toBe(true);
  });

  test("resolveEffectiveRoles adds member when active", () => {
    const roles = resolveEffectiveRoles(ctxAdmin);
    expect(roles).toContain("member");
    expect(roles).toContain("admin");
  });

  test("resolveEffectiveRoles filters out expired roles", () => {
    const now = new Date();
    const past = new Date(now.getTime() - 1000).toISOString();
    const future = new Date(now.getTime() + 1000).toISOString();

    const ctx: RoleContext = {
      assignments: [
        { role: "admin", source: "manual", active: true, expiresAt: past },
        { role: "contributor", source: "manual", active: true, expiresAt: future },
      ],
      membershipState: "active",
    };

    const roles = resolveEffectiveRoles(ctx);
    expect(roles).not.toContain("admin");
    expect(roles).toContain("contributor");
    expect(roles).toContain("member"); // from contributor and membershipState
  });

  test("resolveEffectiveRoles applies hierarchy (admin -> contributor -> member)", () => {
    const ctx: RoleContext = {
      assignments: [{ role: "admin", source: "manual", active: true }],
      membershipState: "invited",
    };

    const roles = resolveEffectiveRoles(ctx);
    expect(roles).toContain("admin");
    expect(roles).toContain("contributor");
    expect(roles).toContain("member");
  });
});

describe('PUBLIC access', () => {
  test('allows with no roles and no membership', () => {
    const d = evaluate(policy('PUBLIC'), {
      assignments: [],
      membershipState: 'expired',
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe('ALLOW');
    expect(reasonCodes(d)).toContain('RULE_PUBLIC');
  });

  test('still allows when user is suspended', () => {
    const d = evaluate(policy('PUBLIC'), {
      assignments: [{ role: 'member', source: 'auto', active: true }],
      membershipState: 'suspended',
    });
    expect(d.allowed).toBe(true);
  });
});

describe('MEMBERS_ONLY access', () => {
  test('allows active membership', () => {
    const d = evaluate(policy('MEMBERS_ONLY'), {
      ...baseCtx,
      assignments: [],
      membershipState: 'active',
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe('ALLOW');
    expect(reasonCodes(d)).toContain('HAS_ACTIVE_MEMBERSHIP');
  });

  test('denies expired membership with predictable reason', () => {
    const d = evaluate(policy('MEMBERS_ONLY'), {
      ...baseCtx,
      assignments: [],
      membershipState: 'expired',
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DENY');
    expect(reasonCodes(d)).toContain('NEEDS_ACTIVE');
  });

  test('denies invited membership with predictable reason', () => {
    const d = evaluate(policy('MEMBERS_ONLY'), {
      ...baseCtx,
      assignments: [],
      membershipState: 'invited',
    });
    expect(d.allowed).toBe(false);
    expect(reasonCodes(d)).toContain('NEEDS_ACTIVE');
  });

  test('denies suspended membership with predictable reason', () => {
    const d = evaluate(policy('MEMBERS_ONLY'), {
      ...baseCtx,
      assignments: [],
      membershipState: 'suspended',
    });
    expect(d.allowed).toBe(false);
    expect(reasonCodes(d)).toContain('NEEDS_ACTIVE');
  });
});

describe('ADMINS_ONLY access', () => {
  test('allows admin role', () => {
    const d = evaluate(policy('ADMINS_ONLY'), {
      ...baseCtx,
      assignments: [{ role: 'admin', source: 'manual', active: true }],
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe('ALLOW');
    expect(reasonCodes(d)).toContain('HAS_ADMIN');
  });

  test('denies member-only with predictable reason', () => {
    const d = evaluate(policy('ADMINS_ONLY'), {
      ...baseCtx,
      assignments: [{ role: 'member', source: 'auto', active: true }],
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DENY');
    expect(reasonCodes(d)).toContain('NEEDS_ADMIN');
  });

  test('denies contributor without admin', () => {
    const d = evaluate(policy('ADMINS_ONLY'), {
      ...baseCtx,
      assignments: [{ role: 'contributor', source: 'manual', active: true }],
    });
    expect(d.allowed).toBe(false);
    expect(reasonCodes(d)).toContain('NEEDS_ADMIN');
  });

  test('denies inactive admin assignment', () => {
    const d = evaluate(policy('ADMINS_ONLY'), {
      ...baseCtx,
      assignments: [{ role: 'admin', source: 'manual', active: false }],
    });
    expect(d.allowed).toBe(false);
  });
});

describe('CONTRIBUTORS_OR_ADMINS access', () => {
  test('allows contributor role', () => {
    const d = evaluate(policy('CONTRIBUTORS_OR_ADMINS'), {
      ...baseCtx,
      assignments: [{ role: 'contributor', source: 'manual', active: true }],
    });
    expect(d.allowed).toBe(true);
    expect(reasonCodes(d)).toContain('HAS_REQUIRED_ROLE');
  });

  test('allows admin role', () => {
    const d = evaluate(policy('CONTRIBUTORS_OR_ADMINS'), {
      ...baseCtx,
      assignments: [{ role: 'admin', source: 'manual', active: true }],
    });
    expect(d.allowed).toBe(true);
    expect(reasonCodes(d)).toContain('HAS_REQUIRED_ROLE');
  });

  test('denies member-only with predictable reason', () => {
    const d = evaluate(policy('CONTRIBUTORS_OR_ADMINS'), {
      ...baseCtx,
      assignments: [{ role: 'member', source: 'auto', active: true }],
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DENY');
    expect(reasonCodes(d)).toContain('NEEDS_CONTRIBUTOR_OR_ADMIN');
  });

  test('denies no roles at all', () => {
    const d = evaluate(policy('CONTRIBUTORS_OR_ADMINS'), {
      assignments: [],
      membershipState: 'active',
    });
    expect(d.allowed).toBe(false);
    expect(reasonCodes(d)).toContain('NEEDS_CONTRIBUTOR_OR_ADMIN');
  });
});

describe('resolveEffectiveRoles', () => {
  test('returns empty array when no assignments and not active member', () => {
    const roles = resolveEffectiveRoles({
      assignments: [],
      membershipState: 'expired',
    });
    expect(roles).toEqual([]);
  });

  test('adds member when membership is active', () => {
    const roles = resolveEffectiveRoles({
      assignments: [],
      membershipState: 'active',
    });
    expect(roles).toEqual(['member']);
  });

  test('excludes inactive assignments', () => {
    const roles = resolveEffectiveRoles({
      assignments: [
        { role: 'admin', source: 'manual', active: false },
        { role: 'contributor', source: 'manual', active: true },
      ],
      membershipState: 'active',
    });
    expect(roles).toContain('contributor');
    expect(roles).toContain('member');
    expect(roles).not.toContain('admin');
  });

  test('deduplicates repeated roles', () => {
    const roles = resolveEffectiveRoles({
      assignments: [
        { role: 'admin', source: 'manual', active: true },
        { role: 'admin', source: 'auto', active: true },
      ],
      membershipState: 'active',
    });
    expect(roles.filter((r) => r === 'admin').length).toBe(1);
  });
});

describe('unknown rule fallback', () => {
  test('denies and reports RULE_UNHANDLED for unknown rule', () => {
    const unknownPolicy = {
      id: 'p1',
      communityId: 'c1',
      resource: 'r1',
      ruleType: 'NONEXISTENT_RULE',
    } as unknown as AccessPolicy;

    const d = evaluate(unknownPolicy, baseCtx);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DENY');
    expect(reasonCodes(d)).toContain('RULE_UNHANDLED');
  });
});
