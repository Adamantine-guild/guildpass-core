import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  evaluateEligibilityRule,
  parseEligibilityRule,
  EligibilityRuleError,
  DEFAULT_ELIGIBILITY_RULE_LIMITS,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const eq = (field: string, value: string | number | boolean) =>
  ({ type: "equals", field, value } as const);

const exists = (field: string) => ({ type: "exists", field } as const);

const inList = (field: string, values: Array<string | number>) =>
  ({ type: "in", field, values } as const);

const gte = (field: string, value: number) =>
  ({ type: "gte", field, value } as const);

const lte = (field: string, value: number) =>
  ({ type: "lte", field, value } as const);

const all = (children: unknown[]) => ({ type: "all", children } as const);

const any = (children: unknown[]) => ({ type: "any", children } as const);

const not = (child: unknown) => ({ type: "not", child } as const);

// ---------------------------------------------------------------------------
// equals
// ---------------------------------------------------------------------------

describe("evaluateEligibilityRule - equals", () => {
  it("returns eligible when the field matches a string value", () => {
    const result = evaluateEligibilityRule(eq("status", "active"), {
      status: "active",
    });
    assert.strictEqual(result.eligible, true);
  });

  it("returns ineligible when the field does not match a string value", () => {
    const result = evaluateEligibilityRule(eq("status", "active"), {
      status: "suspended",
    });
    assert.strictEqual(result.eligible, false);
  });

  it("matches a numeric value", () => {
    const result = evaluateEligibilityRule(eq("score", 42), { score: 42 });
    assert.strictEqual(result.eligible, true);
  });

  it("does not match a number to its string representation", () => {
    const result = evaluateEligibilityRule(eq("score", 42), { score: "42" });
    assert.strictEqual(result.eligible, false);
  });

  it("matches a boolean value", () => {
    assert.strictEqual(
      evaluateEligibilityRule(eq("verified", true), { verified: true }).eligible,
      true
    );
    assert.strictEqual(
      evaluateEligibilityRule(eq("verified", true), { verified: false }).eligible,
      false
    );
  });

  it("returns ineligible when the field is missing", () => {
    const result = evaluateEligibilityRule(eq("status", "active"), {});
    assert.strictEqual(result.eligible, false);
  });
});

// ---------------------------------------------------------------------------
// exists
// ---------------------------------------------------------------------------

describe("evaluateEligibilityRule - exists", () => {
  it("returns eligible when the field is present", () => {
    assert.strictEqual(
      evaluateEligibilityRule(exists("wallet"), { wallet: "GABC" }).eligible,
      true
    );
  });

  it("returns eligible when the field is present and null", () => {
    assert.strictEqual(
      evaluateEligibilityRule(exists("wallet"), { wallet: null }).eligible,
      true
    );
  });

  it("returns eligible when the field is present and false", () => {
    assert.strictEqual(
      evaluateEligibilityRule(exists("active"), { active: false }).eligible,
      true
    );
  });

  it("returns ineligible when the field is absent", () => {
    assert.strictEqual(
      evaluateEligibilityRule(exists("wallet"), {}).eligible,
      false
    );
  });
});

// ---------------------------------------------------------------------------
// in
// ---------------------------------------------------------------------------

describe("evaluateEligibilityRule - in", () => {
  it("returns eligible when the field value is in the list", () => {
    assert.strictEqual(
      evaluateEligibilityRule(inList("role", ["admin", "moderator"]), {
        role: "admin",
      }).eligible,
      true
    );
  });

  it("returns ineligible when the field value is not in the list", () => {
    assert.strictEqual(
      evaluateEligibilityRule(inList("role", ["admin", "moderator"]), {
        role: "member",
      }).eligible,
      false
    );
  });

  it("works with numeric values", () => {
    assert.strictEqual(
      evaluateEligibilityRule(inList("tier", [1, 2, 3]), { tier: 2 }).eligible,
      true
    );
    assert.strictEqual(
      evaluateEligibilityRule(inList("tier", [1, 2, 3]), { tier: 5 }).eligible,
      false
    );
  });

  it("returns ineligible when the field is missing", () => {
    assert.strictEqual(
      evaluateEligibilityRule(inList("role", ["admin"]), {}).eligible,
      false
    );
  });

  it("returns ineligible when the fact value is not a string or number", () => {
    assert.strictEqual(
      evaluateEligibilityRule(inList("role", ["admin"]), { role: true }).eligible,
      false
    );
  });

  it("handles an empty values list (always false)", () => {
    assert.strictEqual(
      evaluateEligibilityRule(inList("role", []), { role: "admin" }).eligible,
      false
    );
  });
});

// ---------------------------------------------------------------------------
// gte
// ---------------------------------------------------------------------------

describe("evaluateEligibilityRule - gte", () => {
  it("returns eligible when the field value is exactly equal", () => {
    assert.strictEqual(
      evaluateEligibilityRule(gte("age", 18), { age: 18 }).eligible,
      true
    );
  });

  it("returns eligible when the field value is greater", () => {
    assert.strictEqual(
      evaluateEligibilityRule(gte("age", 18), { age: 25 }).eligible,
      true
    );
  });

  it("returns ineligible when the field value is less", () => {
    assert.strictEqual(
      evaluateEligibilityRule(gte("age", 18), { age: 17 }).eligible,
      false
    );
  });

  it("returns ineligible when the field is missing", () => {
    assert.strictEqual(
      evaluateEligibilityRule(gte("age", 18), {}).eligible,
      false
    );
  });

  it("returns ineligible when the field value is not a number", () => {
    assert.strictEqual(
      evaluateEligibilityRule(gte("age", 18), { age: "twenty" }).eligible,
      false
    );
  });
});

// ---------------------------------------------------------------------------
// lte
// ---------------------------------------------------------------------------

describe("evaluateEligibilityRule - lte", () => {
  it("returns eligible when the field value is exactly equal", () => {
    assert.strictEqual(
      evaluateEligibilityRule(lte("count", 10), { count: 10 }).eligible,
      true
    );
  });

  it("returns eligible when the field value is less", () => {
    assert.strictEqual(
      evaluateEligibilityRule(lte("count", 10), { count: 3 }).eligible,
      true
    );
  });

  it("returns ineligible when the field value is greater", () => {
    assert.strictEqual(
      evaluateEligibilityRule(lte("count", 10), { count: 11 }).eligible,
      false
    );
  });

  it("returns ineligible when the field is missing", () => {
    assert.strictEqual(
      evaluateEligibilityRule(lte("count", 10), {}).eligible,
      false
    );
  });

  it("returns ineligible when the field value is not a number", () => {
    assert.strictEqual(
      evaluateEligibilityRule(lte("count", 10), { count: "five" }).eligible,
      false
    );
  });
});

// ---------------------------------------------------------------------------
// all
// ---------------------------------------------------------------------------

describe("evaluateEligibilityRule - all", () => {
  it("requires every child rule to pass", () => {
    const rule = all([eq("status", "active"), gte("age", 18)]);
    assert.strictEqual(
      evaluateEligibilityRule(rule, { status: "active", age: 20 }).eligible,
      true
    );
    assert.strictEqual(
      evaluateEligibilityRule(rule, { status: "active", age: 16 }).eligible,
      false
    );
    assert.strictEqual(
      evaluateEligibilityRule(rule, { status: "suspended", age: 20 }).eligible,
      false
    );
  });

  it("is vacuously true with no children", () => {
    assert.strictEqual(
      evaluateEligibilityRule(all([]), {}).eligible,
      true
    );
  });
});

// ---------------------------------------------------------------------------
// any
// ---------------------------------------------------------------------------

describe("evaluateEligibilityRule - any", () => {
  it("requires at least one child rule to pass", () => {
    const rule = any([eq("role", "admin"), eq("role", "moderator")]);
    assert.strictEqual(
      evaluateEligibilityRule(rule, { role: "admin" }).eligible,
      true
    );
    assert.strictEqual(
      evaluateEligibilityRule(rule, { role: "moderator" }).eligible,
      true
    );
    assert.strictEqual(
      evaluateEligibilityRule(rule, { role: "member" }).eligible,
      false
    );
  });

  it("is vacuously false with no children", () => {
    assert.strictEqual(
      evaluateEligibilityRule(any([]), {}).eligible,
      false
    );
  });
});

// ---------------------------------------------------------------------------
// not
// ---------------------------------------------------------------------------

describe("evaluateEligibilityRule - not", () => {
  it("inverts a passing child", () => {
    assert.strictEqual(
      evaluateEligibilityRule(not(eq("status", "banned")), {
        status: "banned",
      }).eligible,
      false
    );
  });

  it("inverts a failing child", () => {
    assert.strictEqual(
      evaluateEligibilityRule(not(eq("status", "banned")), {
        status: "active",
      }).eligible,
      true
    );
  });

  it("inverts an exists rule", () => {
    assert.strictEqual(
      evaluateEligibilityRule(not(exists("suspendedAt")), {}).eligible,
      true
    );
    assert.strictEqual(
      evaluateEligibilityRule(not(exists("suspendedAt")), {
        suspendedAt: "2025-01-01",
      }).eligible,
      false
    );
  });
});

// ---------------------------------------------------------------------------
// Nested composition
// ---------------------------------------------------------------------------

describe("evaluateEligibilityRule - nested composition", () => {
  it("evaluates a realistic community eligibility rule tree", () => {
    // (status == active AND age >= 18) AND (role IN [member, contributor] OR NOT suspended)
    const rule = all([
      all([eq("status", "active"), gte("age", 18)]),
      any([inList("role", ["member", "contributor"]), not(exists("suspendedAt"))]),
    ]);

    assert.strictEqual(
      evaluateEligibilityRule(rule, {
        status: "active",
        age: 20,
        role: "contributor",
      }).eligible,
      true
    );

    assert.strictEqual(
      evaluateEligibilityRule(rule, {
        status: "active",
        age: 20,
      }).eligible,
      true // no suspendedAt present, so NOT exists passes
    );

    assert.strictEqual(
      evaluateEligibilityRule(rule, {
        status: "active",
        age: 16,
        role: "member",
      }).eligible,
      false // fails age >= 18
    );

    assert.strictEqual(
      evaluateEligibilityRule(rule, {
        status: "suspended",
        age: 22,
        role: "member",
      }).eligible,
      false // fails status == active
    );
  });

  it("handles deeply nested not/all/any combinations", () => {
    // NOT (all [status == banned, any [role == admin, role == moderator]])
    const rule = not(
      all([
        eq("status", "banned"),
        any([eq("role", "admin"), eq("role", "moderator")]),
      ])
    );

    // Banned admin: outer not inverts a passing all => ineligible
    assert.strictEqual(
      evaluateEligibilityRule(rule, { status: "banned", role: "admin" }).eligible,
      false
    );

    // Banned member: inner any fails => all fails => not true => eligible
    assert.strictEqual(
      evaluateEligibilityRule(rule, { status: "banned", role: "member" }).eligible,
      true
    );

    // Active admin: outer all fails (status != banned) => not true => eligible
    assert.strictEqual(
      evaluateEligibilityRule(rule, { status: "active", role: "admin" }).eligible,
      true
    );
  });

  it("is deterministic and side-effect free", () => {
    const rule = Object.freeze(
      all([eq("status", "active"), gte("score", 100)])
    );
    const facts = Object.freeze({ status: "active", score: 150 });

    const first = evaluateEligibilityRule(rule, facts);
    const second = evaluateEligibilityRule(rule, facts);
    assert.deepStrictEqual(first, second);
  });
});

// ---------------------------------------------------------------------------
// Nested fact paths
// ---------------------------------------------------------------------------

describe("evaluateEligibilityRule - dot-separated fact paths", () => {
  it("resolves nested fact paths with dot notation", () => {
    assert.strictEqual(
      evaluateEligibilityRule(eq("profile.status", "active"), {
        profile: { status: "active" },
      }).eligible,
      true
    );
  });

  it("returns ineligible for a partially-present nested path", () => {
    assert.strictEqual(
      evaluateEligibilityRule(eq("profile.status", "active"), {
        profile: {},
      }).eligible,
      false
    );
  });

  it("returns ineligible for a deeply-missing path", () => {
    assert.strictEqual(
      evaluateEligibilityRule(exists("a.b.c"), {}).eligible,
      false
    );
    assert.strictEqual(
      evaluateEligibilityRule(exists("a.b.c"), { a: { b: { c: 1 } } }).eligible,
      true
    );
  });

  it("handles null mid-path gracefully", () => {
    assert.strictEqual(
      evaluateEligibilityRule(exists("profile.status"), { profile: null }).eligible,
      false
    );
  });
});

// ---------------------------------------------------------------------------
// parseEligibilityRule - malformed input rejection
// ---------------------------------------------------------------------------

describe("parseEligibilityRule - malformed input rejection", () => {
  const invalidCases: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "equals"],
    ["a number", 42],
    ["an array", []],
    ["an object with no type", {}],
    ["an object with an unknown type", { type: "regex" }],
    // equals
    ["equals with missing field", { type: "equals", value: "x" }],
    ["equals with empty field", { type: "equals", field: "", value: "x" }],
    ["equals with missing value", { type: "equals", field: "f" }],
    ["equals with null value", { type: "equals", field: "f", value: null }],
    ["equals with array value", { type: "equals", field: "f", value: ["x"] }],
    // exists
    ["exists with missing field", { type: "exists" }],
    ["exists with empty field", { type: "exists", field: "" }],
    // in
    ["in with missing field", { type: "in", values: ["x"] }],
    ["in with missing values", { type: "in", field: "f" }],
    ["in with non-array values", { type: "in", field: "f", values: "x" }],
    ["in with boolean in values array", { type: "in", field: "f", values: [true] }],
    // gte
    ["gte with missing field", { type: "gte", value: 5 }],
    ["gte with non-numeric value", { type: "gte", field: "f", value: "5" }],
    ["gte with NaN value", { type: "gte", field: "f", value: NaN }],
    ["gte with Infinity", { type: "gte", field: "f", value: Infinity }],
    // lte
    ["lte with missing field", { type: "lte", value: 5 }],
    ["lte with non-numeric value", { type: "lte", field: "f", value: "5" }],
    // not
    ["not with missing child", { type: "not" }],
    ["not with invalid child", { type: "not", child: { type: "bogus" } }],
    // all
    ["all with missing children", { type: "all" }],
    ["all with non-array children", { type: "all", children: "nope" }],
    ["all with an invalid child", all([eq("x", 1), { type: "bad" }])],
    // any
    ["any with missing children", { type: "any" }],
    ["any with non-array children", { type: "any", children: {} }],
  ];

  for (const [description, input] of invalidCases) {
    it(`rejects ${description}`, () => {
      assert.throws(
        () => parseEligibilityRule(input),
        (err: unknown) => err instanceof EligibilityRuleError
      );
    });
  }

  it("rejects rather than evaluates malformed input passed to evaluate", () => {
    assert.throws(
      () => evaluateEligibilityRule({ type: "equals", field: "x" }, {}),
      (err: unknown) => err instanceof EligibilityRuleError
    );
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe("parseEligibilityRule - depth and node limits", () => {
  it("rejects rules deeper than the configured maximum", () => {
    let rule: unknown = eq("f", 1);
    for (let i = 0; i < 10; i += 1) {
      rule = all([rule]);
    }

    assert.throws(
      () => parseEligibilityRule(rule, { maxDepth: 5, maxNodes: 1000 }),
      (err: unknown) =>
        err instanceof EligibilityRuleError && err.code === "MAX_DEPTH_EXCEEDED"
    );

    assert.doesNotThrow(() =>
      parseEligibilityRule(rule, { maxDepth: 20, maxNodes: 1000 })
    );
  });

  it("rejects rules with more nodes than the configured maximum", () => {
    const children = Array.from({ length: 50 }, (_, i) => eq(`f${i}`, i));
    const rule = all(children);

    assert.throws(
      () => parseEligibilityRule(rule, { maxDepth: 10, maxNodes: 10 }),
      (err: unknown) =>
        err instanceof EligibilityRuleError && err.code === "MAX_NODES_EXCEEDED"
    );
  });

  it("rejects a pathologically wide rule without doing unbounded work", () => {
    const children = Array.from({ length: 200_000 }, (_, i) => eq(`f${i}`, i));
    const rule = all(children);

    const start = Date.now();
    assert.throws(
      () => parseEligibilityRule(rule, { maxDepth: 10, maxNodes: 500 }),
      (err: unknown) =>
        err instanceof EligibilityRuleError && err.code === "MAX_NODES_EXCEEDED"
    );
    assert.ok(Date.now() - start < 500);
  });

  it("rejects a self-referential (cyclic) rule via the depth limit", () => {
    const cyclic: { type: "all"; children: unknown[] } = {
      type: "all",
      children: [],
    };
    cyclic.children.push(cyclic);

    assert.throws(
      () =>
        parseEligibilityRule(cyclic, { maxDepth: 25, maxNodes: 10_000 }),
      (err: unknown) =>
        err instanceof EligibilityRuleError && err.code === "MAX_DEPTH_EXCEEDED"
    );
  });

  it("applies exported default limits when none are supplied", () => {
    const result = evaluateEligibilityRule(eq("status", "active"), {
      status: "active",
    });
    assert.strictEqual(result.eligible, true);
  });

  it("exposes DEFAULT_ELIGIBILITY_RULE_LIMITS with positive maxDepth and maxNodes", () => {
    assert.ok(DEFAULT_ELIGIBILITY_RULE_LIMITS.maxDepth > 0);
    assert.ok(DEFAULT_ELIGIBILITY_RULE_LIMITS.maxNodes > 0);
  });
});

// ---------------------------------------------------------------------------
// Explain mode
// ---------------------------------------------------------------------------

describe("evaluateEligibilityRule - explain mode", () => {
  it("omits denialReasons when the rule is eligible", () => {
    const result = evaluateEligibilityRule(
      eq("status", "active"),
      { status: "active" },
      { explain: true }
    );
    assert.strictEqual(result.eligible, true);
    assert.strictEqual(result.denialReasons, undefined);
  });

  it("reports missing field reason for equals", () => {
    const result = evaluateEligibilityRule(eq("status", "active"), {}, {
      explain: true,
    });
    assert.strictEqual(result.eligible, false);
    assert.ok(Array.isArray(result.denialReasons));
    assert.strictEqual(result.denialReasons!.length, 1);
    assert.strictEqual(result.denialReasons![0].ruleType, "equals");
    assert.ok(result.denialReasons![0].reason.includes("missing"));
  });

  it("reports wrong-value reason for equals", () => {
    const result = evaluateEligibilityRule(
      eq("status", "active"),
      { status: "suspended" },
      { explain: true }
    );
    assert.strictEqual(result.eligible, false);
    assert.ok(result.denialReasons![0].reason.includes("suspended"));
  });

  it("reports missing field reason for exists", () => {
    const result = evaluateEligibilityRule(exists("wallet"), {}, {
      explain: true,
    });
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.denialReasons![0].ruleType, "exists");
    assert.ok(result.denialReasons![0].reason.includes("missing"));
  });

  it("reports denial reason for in", () => {
    const result = evaluateEligibilityRule(
      inList("role", ["admin", "mod"]),
      { role: "member" },
      { explain: true }
    );
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.denialReasons![0].ruleType, "in");
    assert.ok(result.denialReasons![0].reason.includes("member"));
  });

  it("reports denial reason for gte", () => {
    const result = evaluateEligibilityRule(gte("score", 100), { score: 50 }, {
      explain: true,
    });
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.denialReasons![0].ruleType, "gte");
  });

  it("reports denial reason for lte", () => {
    const result = evaluateEligibilityRule(lte("count", 5), { count: 10 }, {
      explain: true,
    });
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.denialReasons![0].ruleType, "lte");
  });

  it("reports only failing branches in an all rule", () => {
    const rule = all([eq("status", "active"), gte("age", 18), exists("wallet")]);
    const result = evaluateEligibilityRule(
      rule,
      { status: "active", age: 25 },
      { explain: true }
    );
    assert.strictEqual(result.eligible, false);
    const types = result.denialReasons!.map((r) => r.ruleType);
    assert.ok(types.includes("exists"));
    assert.ok(!types.includes("equals") || result.denialReasons!.length === 1);
  });

  it("reports all branches in a fully-failing any rule", () => {
    const rule = any([eq("role", "admin"), eq("role", "moderator")]);
    const result = evaluateEligibilityRule(rule, { role: "member" }, {
      explain: true,
    });
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.denialReasons!.length, 2);
  });

  it("reports the triggering leaf for a not denial", () => {
    const result = evaluateEligibilityRule(
      not(eq("status", "banned")),
      { status: "banned" },
      { explain: true }
    );
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.denialReasons!.length, 1);
    assert.strictEqual(result.denialReasons![0].ruleType, "equals");
    assert.ok(result.denialReasons![0].reason.includes("forbidden"));
  });

  it("provides complete denial reasons across a deeply nested tree", () => {
    const rule = all([
      eq("status", "active"),
      any([gte("score", 100), inList("badge", ["gold", "platinum"])]),
      not(exists("suspendedAt")),
    ]);

    // fails: score < 100, no badge, has suspendedAt
    const result = evaluateEligibilityRule(
      rule,
      { status: "active", score: 50, suspendedAt: "2025-01-01" },
      { explain: true }
    );
    assert.strictEqual(result.eligible, false);
    assert.ok(result.denialReasons!.length >= 2);
  });
});

// ---------------------------------------------------------------------------
// EligibilityRuleError shape
// ---------------------------------------------------------------------------

describe("EligibilityRuleError", () => {
  it("carries the error code and path", () => {
    try {
      parseEligibilityRule({ type: "equals", field: "f" });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof EligibilityRuleError);
      assert.strictEqual(err.code, "INVALID_SCALAR_VALUE");
      assert.ok(err.message.includes("<root>"));
    }
  });

  it("includes a path for errors inside nested nodes", () => {
    try {
      parseEligibilityRule(all([eq("f", 1), { type: "gte", field: "x", value: "not-a-number" }]));
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof EligibilityRuleError);
      assert.ok(err.path.length > 0);
    }
  });
});
