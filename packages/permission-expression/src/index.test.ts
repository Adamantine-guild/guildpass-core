import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  evaluatePermissionExpression,
  parsePermissionExpression,
  PermissionExpressionError,
} from "./index.js";

const perm = (value: string) => ({ type: "permission", value } as const);
const all = (children: unknown[]) => ({ type: "all", children } as const);
const any = (children: unknown[]) => ({ type: "any", children } as const);
const not = (child: unknown) => ({ type: "not", child } as const);

describe("evaluatePermissionExpression - leaf permissions", () => {
  it("grants when the permission is present", () => {
    const result = evaluatePermissionExpression(perm("community.manage"), [
      "community.manage",
    ]);
    assert.strictEqual(result.granted, true);
  });

  it("denies when the permission is absent", () => {
    const result = evaluatePermissionExpression(perm("community.manage"), [
      "community.read",
    ]);
    assert.strictEqual(result.granted, false);
  });
});

describe("evaluatePermissionExpression - all", () => {
  it("requires every child to pass", () => {
    const expr = all([perm("community.read"), perm("members.manage")]);

    assert.strictEqual(
      evaluatePermissionExpression(expr, ["community.read", "members.manage"])
        .granted,
      true
    );
    assert.strictEqual(
      evaluatePermissionExpression(expr, ["community.read"]).granted,
      false
    );
  });

  it("treats an empty children array as vacuously true", () => {
    const result = evaluatePermissionExpression(all([]), []);
    assert.strictEqual(result.granted, true);
  });
});

describe("evaluatePermissionExpression - any", () => {
  it("requires at least one child to pass", () => {
    const expr = any([perm("admin"), perm("moderator")]);

    assert.strictEqual(
      evaluatePermissionExpression(expr, ["moderator"]).granted,
      true
    );
    assert.strictEqual(
      evaluatePermissionExpression(expr, ["member"]).granted,
      false
    );
  });

  it("treats an empty children array as vacuously false", () => {
    const result = evaluatePermissionExpression(any([]), ["anything"]);
    assert.strictEqual(result.granted, false);
  });
});

describe("evaluatePermissionExpression - not", () => {
  it("inverts a granted child", () => {
    const result = evaluatePermissionExpression(not(perm("banned")), [
      "banned",
    ]);
    assert.strictEqual(result.granted, false);
  });

  it("inverts a denied child", () => {
    const result = evaluatePermissionExpression(not(perm("banned")), [
      "member",
    ]);
    assert.strictEqual(result.granted, true);
  });
});

describe("evaluatePermissionExpression - nesting", () => {
  it("evaluates a mixed nested expression", () => {
    // (admin OR (community.read AND members.manage)) AND NOT banned
    const expr = all([
      any([
        perm("admin"),
        all([perm("community.read"), perm("members.manage")]),
      ]),
      not(perm("banned")),
    ]);

    assert.strictEqual(
      evaluatePermissionExpression(expr, ["admin"]).granted,
      true
    );
    assert.strictEqual(
      evaluatePermissionExpression(expr, [
        "community.read",
        "members.manage",
      ]).granted,
      true
    );
    assert.strictEqual(
      evaluatePermissionExpression(expr, ["community.read"]).granted,
      false
    );
    assert.strictEqual(
      evaluatePermissionExpression(expr, ["admin", "banned"]).granted,
      false
    );
  });

  it("accepts a Set, an array, and an arbitrary iterable for granted permissions", () => {
    const expr = perm("community.manage");
    assert.strictEqual(
      evaluatePermissionExpression(expr, new Set(["community.manage"]))
        .granted,
      true
    );
    assert.strictEqual(
      evaluatePermissionExpression(expr, ["community.manage"]).granted,
      true
    );

    function* generator() {
      yield "community.manage";
    }
    assert.strictEqual(
      evaluatePermissionExpression(expr, generator()).granted,
      true
    );
  });

  it("is deterministic and side-effect free", () => {
    const expr = Object.freeze(
      all([perm("a"), any([perm("b"), perm("c")])])
    );
    const granted = Object.freeze(["a", "b"]);

    const first = evaluatePermissionExpression(expr, granted);
    const second = evaluatePermissionExpression(expr, granted);
    assert.deepStrictEqual(first, second);
  });
});

describe("parsePermissionExpression - malformed input rejection", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "permission"],
    ["a number", 42],
    ["an array", []],
    ["an object with no type", {}],
    ["an object with an unknown type", { type: "maybe" }],
    ["a permission node with no value", { type: "permission" }],
    ["a permission node with an empty value", { type: "permission", value: "" }],
    ["a permission node with a numeric value", { type: "permission", value: 1 }],
    ["an all node with non-array children", { type: "all", children: "nope" }],
    ["an any node with missing children", { type: "any" }],
    ["a not node with a missing child", { type: "not" }],
    ["a not node with a malformed child", { type: "not", child: { type: "bogus" } }],
    [
      "an all node with one malformed child among valid ones",
      all([perm("ok"), { type: "nonsense" }]),
    ],
  ];

  for (const [description, input] of cases) {
    it(`rejects ${description}`, () => {
      assert.throws(
        () => parsePermissionExpression(input),
        PermissionExpressionError
      );
    });
  }

  it("rejects rather than evaluates malformed input passed to evaluate", () => {
    assert.throws(
      () => evaluatePermissionExpression({ type: "permission" }, ["x"]),
      PermissionExpressionError
    );
  });
});

describe("parsePermissionExpression - limits", () => {
  it("rejects expressions deeper than the configured maximum", () => {
    let expr: unknown = perm("leaf");
    for (let i = 0; i < 10; i += 1) {
      expr = all([expr]);
    }

    assert.throws(
      () => parsePermissionExpression(expr, { maxDepth: 5, maxNodes: 1000 }),
      (err: unknown) =>
        err instanceof PermissionExpressionError &&
        err.code === "MAX_DEPTH_EXCEEDED"
    );

    // The same expression passes comfortably under a generous depth limit.
    assert.doesNotThrow(() =>
      parsePermissionExpression(expr, { maxDepth: 20, maxNodes: 1000 })
    );
  });

  it("rejects expressions with more nodes than the configured maximum", () => {
    const children = Array.from({ length: 50 }, (_, i) => perm(`p${i}`));
    const expr = all(children);

    assert.throws(
      () => parsePermissionExpression(expr, { maxDepth: 10, maxNodes: 10 }),
      (err: unknown) =>
        err instanceof PermissionExpressionError &&
        err.code === "MAX_NODES_EXCEEDED"
    );
  });

  it("rejects a pathologically wide expression without doing unbounded work", () => {
    const wideChildCount = 200_000;
    const children = Array.from({ length: wideChildCount }, (_, i) => perm(`p${i}`));
    const expr = all(children);

    const start = Date.now();
    assert.throws(
      () => parsePermissionExpression(expr, { maxDepth: 10, maxNodes: 1000 }),
      (err: unknown) =>
        err instanceof PermissionExpressionError &&
        err.code === "MAX_NODES_EXCEEDED"
    );
    // Rejection happens after ~1000 nodes, not after visiting all 200,000.
    assert.ok(Date.now() - start < 500);
  });

  it("rejects a self-referential (cyclic) expression via the depth limit instead of hanging", () => {
    const cyclic: { type: "all"; children: unknown[] } = {
      type: "all",
      children: [],
    };
    cyclic.children.push(cyclic);

    assert.throws(
      () => parsePermissionExpression(cyclic, { maxDepth: 25, maxNodes: 10_000 }),
      (err: unknown) =>
        err instanceof PermissionExpressionError &&
        err.code === "MAX_DEPTH_EXCEEDED"
    );
  });

  it("applies the exported default limits when none are supplied", () => {
    const result = evaluatePermissionExpression(perm("community.manage"), [
      "community.manage",
    ]);
    assert.strictEqual(result.granted, true);
  });
});

describe("evaluatePermissionExpression - explain mode", () => {
  it("omits deniedLeaves when the expression is granted", () => {
    const result = evaluatePermissionExpression(perm("a"), ["a"], {
      explain: true,
    });
    assert.strictEqual(result.granted, true);
    assert.strictEqual(result.deniedLeaves, undefined);
  });

  it("reports only the failing branch of an all expression", () => {
    const expr = all([perm("a"), perm("b"), perm("c")]);
    const result = evaluatePermissionExpression(expr, ["a", "c"], {
      explain: true,
    });
    assert.strictEqual(result.granted, false);
    assert.deepStrictEqual(result.deniedLeaves, [{ type: "permission", value: "b" }]);
  });

  it("reports every branch of a fully-failing any expression", () => {
    const expr = any([perm("admin"), perm("moderator")]);
    const result = evaluatePermissionExpression(expr, ["member"], {
      explain: true,
    });
    assert.strictEqual(result.granted, false);
    assert.deepStrictEqual(result.deniedLeaves, [
      { type: "permission", value: "admin" },
      { type: "permission", value: "moderator" },
    ]);
  });

  it("reports the granted leaf that triggered a not denial", () => {
    const result = evaluatePermissionExpression(not(perm("banned")), ["banned"], {
      explain: true,
    });
    assert.strictEqual(result.granted, false);
    assert.deepStrictEqual(result.deniedLeaves, [
      { type: "permission", value: "banned" },
    ]);
  });

  it("reports nested denial reasons across all/any/not combinations", () => {
    const expr = all([
      any([perm("admin"), perm("moderator")]),
      not(perm("banned")),
    ]);
    const result = evaluatePermissionExpression(expr, ["banned"], {
      explain: true,
    });
    assert.strictEqual(result.granted, false);
    assert.deepStrictEqual(result.deniedLeaves, [
      { type: "permission", value: "admin" },
      { type: "permission", value: "moderator" },
      { type: "permission", value: "banned" },
    ]);
  });
});
