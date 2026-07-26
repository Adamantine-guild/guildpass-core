import {
  validateRuleTree,
  evaluateRuleTree,
  createDefaultEngine,
  ComposablePolicyProvider,
  PUBLIC_RULE_TEMPLATE,
  MEMBERS_ONLY_RULE_TEMPLATE,
  ADMINS_ONLY_RULE_TEMPLATE,
  CONTRIBUTORS_OR_ADMINS_RULE_TEMPLATE,
} from "../src";
import type {
  RuleTree,
  RoleContext,
  AccessPolicy,
  Role,
} from "@guildpass/shared-types";
import type { EvaluationContext } from "../src/types";

describe("Composable Governance Rule Engine", () => {
  const baseContext: RoleContext = {
    assignments: [],
    membershipState: "active",
    wallet: "0x1234567890123456789012345678901234567890",
    communityId: "comm-1",
    resource: "res-1",
    memberSince: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), // 30 days ago
  };

  const createEvalCtx = (
    effectiveRoles: Role[],
    ctxOverrides: Partial<RoleContext> = {}
  ): EvaluationContext => {
    const roleContext: RoleContext = { ...baseContext, ...ctxOverrides };
    const policy: AccessPolicy = {
      id: "policy-1",
      communityId: "comm-1",
      resource: "res-1",
      ruleType: "COMPOSABLE",
    };
    return {
      policy,
      roleContext,
      effectiveRoles,
    };
  };

  describe("Validation & Sandboxing (validateRuleTree)", () => {
    it("accepts valid rule trees", () => {
      const tree: RuleTree = {
        version: "1.0",
        root: {
          type: "AND",
          rules: [
            { type: "ACTIVE_MEMBERSHIP" },
            { type: "HAS_ROLE", role: "admin" },
          ],
        },
      };
      const result = validateRuleTree(tree);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects non-object or null input", () => {
      expect(validateRuleTree(null).valid).toBe(false);
      expect(validateRuleTree("string").valid).toBe(false);
    });

    it("rejects invalid or missing version", () => {
      const tree = {
        root: { type: "ALWAYS_ALLOW" },
      };
      expect(validateRuleTree(tree).valid).toBe(false);
    });

    it("rejects unknown node types", () => {
      const tree = {
        version: "1.0",
        root: { type: "UNKNOWN_TYPE" },
      };
      const res = validateRuleTree(tree);
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("Unknown or unsupported rule node type");
    });

    it("rejects excessive nesting depth beyond limit", () => {
      // Create a 15-level deep AND chain
      let curr: any = { type: "ALWAYS_ALLOW" };
      for (let i = 0; i < 15; i++) {
        curr = { type: "AND", rules: [curr] };
      }
      const tree = { version: "1.0", root: curr };
      const res = validateRuleTree(tree, { maxDepth: 10 });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("maximum nesting depth"))).toBe(true);
    });

    it("rejects excessive node count beyond limit", () => {
      const rules = Array.from({ length: 60 }, () => ({ type: "ALWAYS_ALLOW" }));
      const tree = {
        version: "1.0",
        root: { type: "AND", rules },
      };
      const res = validateRuleTree(tree, { maxNodes: 50 });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("maximum allowed node limit"))).toBe(true);
    });

    it("validates primitive parameters correctly", () => {
      expect(
        validateRuleTree({ version: "1.0", root: { type: "HAS_ROLE", role: "" } }).valid
      ).toBe(false);

      expect(
        validateRuleTree({ version: "1.0", root: { type: "HAS_ANY_ROLE", roles: [] } }).valid
      ).toBe(false);

      expect(
        validateRuleTree({ version: "1.0", root: { type: "HAS_MIN_ROLES", roles: ["admin"], minCount: 2 } }).valid
      ).toBe(true); // Structure is valid, node param is checked

      expect(
        validateRuleTree({ version: "1.0", root: { type: "MEMBERSHIP_DURATION", minDays: -5 } }).valid
      ).toBe(false);
    });
  });

  describe("Primitive Predicates", () => {
    it("evaluates HAS_ROLE correctly", () => {
      const root = { type: "HAS_ROLE" as const, role: "admin" };
      const tracePass = evaluateRuleTree(root, createEvalCtx(["admin", "member"]));
      expect(tracePass.passed).toBe(true);

      const traceFail = evaluateRuleTree(root, createEvalCtx(["member"]));
      expect(traceFail.passed).toBe(false);
    });

    it("evaluates HAS_ANY_ROLE correctly", () => {
      const root = { type: "HAS_ANY_ROLE" as const, roles: ["admin", "contributor"] };
      expect(evaluateRuleTree(root, createEvalCtx(["contributor"])).passed).toBe(true);
      expect(evaluateRuleTree(root, createEvalCtx(["member"])).passed).toBe(false);
    });

    it("evaluates HAS_MIN_ROLES correctly (e.g. any 2 of roles)", () => {
      const root = {
        type: "HAS_MIN_ROLES" as const,
        roles: ["admin", "contributor", "member"],
        minCount: 2,
      };
      expect(evaluateRuleTree(root, createEvalCtx(["admin", "contributor"])).passed).toBe(true);
      expect(evaluateRuleTree(root, createEvalCtx(["admin"])).passed).toBe(false);
    });

    it("evaluates ACTIVE_MEMBERSHIP correctly", () => {
      const root = { type: "ACTIVE_MEMBERSHIP" as const };
      expect(evaluateRuleTree(root, createEvalCtx([], { membershipState: "active" })).passed).toBe(true);
      expect(evaluateRuleTree(root, createEvalCtx([], { membershipState: "expired" })).passed).toBe(false);
    });

    it("evaluates MEMBERSHIP_DURATION correctly", () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 3600 * 1000).toISOString();
      const root = { type: "MEMBERSHIP_DURATION" as const, minDays: 7 };

      expect(evaluateRuleTree(root, createEvalCtx([], { memberSince: tenDaysAgo }), now).passed).toBe(true);
      expect(evaluateRuleTree(root, createEvalCtx([], { memberSince: now.toISOString() }), now).passed).toBe(false);
    });

    it("evaluates HAS_OVERRIDE correctly", () => {
      const root = { type: "HAS_OVERRIDE" as const, effect: "ALLOW" as const };
      const ctxWithOverride = createEvalCtx([], {
        overrides: [
          {
            wallet: "0x1234567890123456789012345678901234567890",
            communityId: "comm-1",
            resource: "res-1",
            effect: "ALLOW",
          },
        ],
      });
      expect(evaluateRuleTree(root, ctxWithOverride).passed).toBe(true);
      expect(evaluateRuleTree(root, createEvalCtx([])).passed).toBe(false);
    });

    it("evaluates TIME_WINDOW correctly", () => {
      const now = new Date("2026-07-24T12:00:00Z"); // Friday
      const validWindow = {
        type: "TIME_WINDOW" as const,
        daysOfWeek: [5], // Friday is 5
        startTime: "09:00",
        endTime: "17:00",
      };
      expect(evaluateRuleTree(validWindow, createEvalCtx([]), now).passed).toBe(true);

      const invalidDayWindow = {
        type: "TIME_WINDOW" as const,
        daysOfWeek: [1, 2], // Mon, Tue
      };
      expect(evaluateRuleTree(invalidDayWindow, createEvalCtx([]), now).passed).toBe(false);
    });

    it("evaluates ALWAYS_ALLOW and ALWAYS_DENY", () => {
      expect(evaluateRuleTree({ type: "ALWAYS_ALLOW" }, createEvalCtx([])).passed).toBe(true);
      expect(evaluateRuleTree({ type: "ALWAYS_DENY" }, createEvalCtx([])).passed).toBe(false);
    });
  });

  describe("Combinator Nodes (AND, OR, NOT)", () => {
    it("evaluates AND combinator correctly", () => {
      const root = {
        type: "AND" as const,
        rules: [
          { type: "ACTIVE_MEMBERSHIP" as const },
          { type: "HAS_ROLE" as const, role: "admin" },
        ],
      };
      const passTrace = evaluateRuleTree(root, createEvalCtx(["admin"], { membershipState: "active" }));
      expect(passTrace.passed).toBe(true);
      expect(passTrace.children).toHaveLength(2);

      const failTrace = evaluateRuleTree(root, createEvalCtx(["member"], { membershipState: "active" }));
      expect(failTrace.passed).toBe(false);
    });

    it("evaluates OR combinator correctly", () => {
      const root = {
        type: "OR" as const,
        rules: [
          { type: "HAS_ROLE" as const, role: "admin" },
          { type: "HAS_ROLE" as const, role: "contributor" },
        ],
      };
      expect(evaluateRuleTree(root, createEvalCtx(["contributor"])).passed).toBe(true);
      expect(evaluateRuleTree(root, createEvalCtx(["member"])).passed).toBe(false);
    });

    it("evaluates NOT combinator correctly", () => {
      const root = {
        type: "NOT" as const,
        rule: { type: "HAS_ROLE" as const, role: "admin" },
      };
      expect(evaluateRuleTree(root, createEvalCtx(["member"])).passed).toBe(true);
      expect(evaluateRuleTree(root, createEvalCtx(["admin"])).passed).toBe(false);
    });
  });

  describe("Complex Nested Governance Scenarios", () => {
    it("handles 'members with role X AND an active membership for at least N days'", () => {
      const root = {
        type: "AND" as const,
        rules: [
          { type: "ACTIVE_MEMBERSHIP" as const },
          { type: "HAS_ROLE" as const, role: "admin" },
          { type: "MEMBERSHIP_DURATION" as const, minDays: 30 },
        ],
      };

      const now = new Date();
      const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 3600 * 1000).toISOString();
      const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 3600 * 1000).toISOString();

      // Veteran admin -> Pass
      const vetModCtx = createEvalCtx(["admin"], { memberSince: fortyDaysAgo });
      const tracePass = evaluateRuleTree(root, vetModCtx, now);
      expect(tracePass.passed).toBe(true);

      // New admin (only 5 days) -> Fail
      const newModCtx = createEvalCtx(["admin"], { memberSince: fiveDaysAgo });
      const traceFail = evaluateRuleTree(root, newModCtx, now);
      expect(traceFail.passed).toBe(false);
      expect(traceFail.children?.find((c: any) => c.type === "MEMBERSHIP_DURATION")?.passed).toBe(false);
    });
  });

  describe("Legacy Rule Equivalence & Parity", () => {
    const engine = createDefaultEngine();

    it("PUBLIC rule template matches legacy behavior", () => {
      const policy: AccessPolicy = {
        id: "p1",
        communityId: "comm-1",
        resource: "res-1",
        ruleType: "PUBLIC",
      };
      const decision = engine.evaluate(policy, baseContext);
      expect(decision.allowed).toBe(true);
    });

    it("MEMBERS_ONLY rule template matches legacy behavior", () => {
      const policy: AccessPolicy = {
        id: "p2",
        communityId: "comm-1",
        resource: "res-1",
        ruleType: "MEMBERS_ONLY",
      };
      expect(engine.evaluate(policy, { ...baseContext, membershipState: "active" }).allowed).toBe(true);
      expect(engine.evaluate(policy, { ...baseContext, membershipState: "expired" }).allowed).toBe(false);
    });

    it("ADMINS_ONLY rule template matches legacy behavior", () => {
      const policy: AccessPolicy = {
        id: "p3",
        communityId: "comm-1",
        resource: "res-1",
        ruleType: "ADMINS_ONLY",
      };
      expect(engine.evaluate(policy, { ...baseContext, membershipState: "active" }, { roleDefinitions: [] }).allowed).toBe(false);
      // Create role assignment for admin
      const adminCtx: RoleContext = {
        ...baseContext,
        assignments: [{ role: "admin", source: "manual", active: true }],
      };
      expect(engine.evaluate(policy, adminCtx).allowed).toBe(true);
    });

    it("CONTRIBUTORS_OR_ADMINS rule template matches legacy behavior", () => {
      const policy: AccessPolicy = {
        id: "p4",
        communityId: "comm-1",
        resource: "res-1",
        ruleType: "CONTRIBUTORS_OR_ADMINS",
      };
      const contribCtx: RoleContext = {
        ...baseContext,
        assignments: [{ role: "contributor", source: "manual", active: true }],
      };
      expect(engine.evaluate(policy, contribCtx).allowed).toBe(true);
    });
  });
});
