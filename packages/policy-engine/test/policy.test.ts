import { evaluate, resolveEffectiveRoles } from "../src";
import type { AccessPolicy, RoleContext } from "@guildpass/shared-types";

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
    const policy: AccessPolicy = {
      id: "1",
      communityId: "c1",
      resource: "home",
      ruleType: "PUBLIC",
    };
    const d = evaluate(policy, ctxAdmin);
    expect(d.allowed).toBe(true);
  });

  test("ADMINS_ONLY denies non-admin", () => {
    const policy: AccessPolicy = {
      id: "1",
      communityId: "c1",
      resource: "admin",
      ruleType: "ADMINS_ONLY",
    };
    const d = evaluate(policy, { ...ctxAdmin, assignments: [] });
    expect(d.allowed).toBe(false);
  });

  test("ADMINS_ONLY allows admin", () => {
    const policy: AccessPolicy = {
      id: "2",
      communityId: "c1",
      resource: "admin",
      ruleType: "ADMINS_ONLY",
    };
    const d = evaluate(policy, ctxAdmin);
    expect(d.allowed).toBe(true);
  });

  test("CONTRIBUTORS_OR_ADMINS denies non-contributor-or-admin", () => {
    const policy: AccessPolicy = {
      id: "3",
      communityId: "c1",
      resource: "tools",
      ruleType: "CONTRIBUTORS_OR_ADMINS",
    };
    const d = evaluate(policy, { assignments: [], membershipState: "active" });
    expect(d.allowed).toBe(false);
  });

  test("Malformed policy params deny safely", () => {
    const policy: AccessPolicy = {
      id: "4",
      communityId: "c1",
      resource: "home",
      ruleType: "PUBLIC",
      params: "not-an-object" as any,
    };
    const d = evaluate(policy, ctxAdmin);
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.code === "MALFORMED_POLICY")).toBe(true);
  });

  test("Unsupported ruleType denies safely", () => {
    const policy: AccessPolicy = {
      id: "5",
      communityId: "c1",
      resource: "secret",
      ruleType: "UNKNOWN_RULE",
    };
    const d = evaluate(policy, ctxAdmin);
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.code === "MALFORMED_POLICY")).toBe(true);
  });

  test("Structured policy params are preserved", () => {
    const policy: AccessPolicy = {
      id: "6",
      communityId: "c1",
      resource: "home",
      ruleType: "PUBLIC",
      params: { minimumRole: "contributor" },
    };
    const d = evaluate(policy, ctxAdmin);
    expect(d.allowed).toBe(true);
    expect(d.reasons.some((r) => r.code === "RULE_PUBLIC")).toBe(true);
  });

  test("resolveEffectiveRoles adds member when active", () => {
    const roles = resolveEffectiveRoles(ctxAdmin);
    expect(roles).toContain("member");
    expect(roles).toContain("admin");
  });
});
