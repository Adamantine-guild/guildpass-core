import { validateRuleTree } from "@guildpass/policy-engine";
import type { RuleTree } from "@guildpass/shared-types";

describe("Composable Policy Integration Tests in access-api", () => {
  it("validates valid custom rule tree AST", () => {
    const validTree: RuleTree = {
      version: "1.0",
      root: {
        type: "AND",
        rules: [
          { type: "ACTIVE_MEMBERSHIP" },
          { type: "HAS_ROLE", role: "admin" },
          { type: "MEMBERSHIP_DURATION", minDays: 14 },
        ],
      },
    };

    const res = validateRuleTree(validTree);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it("rejects malformed rule trees with 400 validation error shape", () => {
    const invalidTree = {
      version: "1.0",
      root: {
        type: "AND",
        rules: [
          { type: "INVALID_PREDICATE_TYPE" },
        ],
      },
    };

    const res = validateRuleTree(invalidTree);
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors[0]).toContain("Unknown or unsupported rule node type");
  });

  it("rejects oversized rule trees exceeding max depth", () => {
    let root: any = { type: "ALWAYS_ALLOW" };
    for (let i = 0; i < 15; i++) {
      root = { type: "AND", rules: [root] };
    }
    const oversizedTree = { version: "1.0", root };

    const res = validateRuleTree(oversizedTree, { maxDepth: 10 });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("nesting depth"))).toBe(true);
  });
});
