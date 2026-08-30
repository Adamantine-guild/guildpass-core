/**
 * Unit tests for the Policy Explanation Engine
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  explainDecision,
  condition,
  all,
  any,
  not,
  ExplanationError,
  isConditionNode,
  isAllNode,
  isAnyNode,
  isNotNode,
  type EvaluationNode,
  type DecisionExplanation
} from "./index.js";

describe("Policy Explanation Engine", () => {
  describe("Basic Condition Nodes", () => {
    it("should explain a passing condition", () => {
      const node = condition("cond1", true, "User is active");
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.reasons.length, 1);
      assert.strictEqual(result.reasons[0].code, "PASS_COND");
      assert.strictEqual(result.reasons[0].nodeId, "cond1");
      assert.strictEqual(result.reasons[0].message, "User is active");
    });

    it("should explain a failing condition", () => {
      const node = condition("cond1", false, "User is inactive");
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.reasons.length, 1);
      assert.strictEqual(result.reasons[0].code, "FAIL_COND");
      assert.strictEqual(result.reasons[0].nodeId, "cond1");
      assert.strictEqual(result.reasons[0].message, "User is inactive");
    });

    it("should handle condition without reason", () => {
      const node = condition("cond1", true);
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.reasons.length, 1);
      assert.strictEqual(result.reasons[0].message, undefined);
    });
  });

  describe("ALL Nodes (Logical AND)", () => {
    it("should pass when all children pass", () => {
      const node = all(
        condition("cond1", true),
        condition("cond2", true),
        condition("cond3", true)
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.reasons.length, 1);
      assert.strictEqual(result.reasons[0].code, "PASS_ALL");
    });

    it("should fail when any child fails", () => {
      const node = all(
        condition("cond1", true),
        condition("cond2", false, "Missing role"),
        condition("cond3", true)
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reasons.length >= 1);
      assert.ok(result.reasons.some(r => r.code === "FAIL_COND" && r.nodeId === "cond2"));
    });

    it("should fail when multiple children fail", () => {
      const node = all(
        condition("cond1", false, "Failed 1"),
        condition("cond2", false, "Failed 2"),
        condition("cond3", true)
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, false);
      // Should report all failing conditions
      const failingReasons = result.reasons.filter(r => r.code === "FAIL_COND");
      assert.ok(failingReasons.length >= 2);
    });

    it("should handle nested ALL nodes", () => {
      const node = all(
        condition("cond1", true),
        all(
          condition("cond2", true),
          condition("cond3", true)
        )
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
    });

    it("should handle nested ALL with failure", () => {
      const node = all(
        condition("cond1", true),
        all(
          condition("cond2", true),
          condition("cond3", false, "Nested failure")
        )
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reasons.some(r => r.nodeId === "cond3"));
    });
  });

  describe("ANY Nodes (Logical OR)", () => {
    it("should pass when at least one child passes", () => {
      const node = any(
        condition("cond1", false),
        condition("cond2", true, "Has admin role"),
        condition("cond3", false)
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
      assert.ok(result.reasons.some(r => r.code === "PASS_COND" && r.nodeId === "cond2"));
    });

    it("should fail when all children fail", () => {
      const node = any(
        condition("cond1", false, "No role A"),
        condition("cond2", false, "No role B"),
        condition("cond3", false, "No role C")
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reasons.some(r => r.code === "FAIL_ANY"));
      assert.ok(result.reasons.some(r => r.message === "No conditions passed"));
    });

    it("should report first passing child", () => {
      const node = any(
        condition("cond1", true, "First pass"),
        condition("cond2", true, "Second pass"),
        condition("cond3", true, "Third pass")
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
      // Should only report the first passing child
      const passingReasons = result.reasons.filter(r => r.code === "PASS_COND");
      assert.strictEqual(passingReasons.length, 1);
      assert.strictEqual(passingReasons[0].nodeId, "cond1");
    });

    it("should handle nested ANY nodes", () => {
      const node = any(
        condition("cond1", false),
        any(
          condition("cond2", false),
          condition("cond3", true, "Nested pass")
        )
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
      assert.ok(result.reasons.some(r => r.nodeId === "cond3"));
    });

    it("should handle nested ANY with all failures", () => {
      const node = any(
        condition("cond1", false),
        any(
          condition("cond2", false),
          condition("cond3", false)
        )
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, false);
    });
  });

  describe("NOT Nodes (Logical Negation)", () => {
    it("should pass when child fails", () => {
      const node = not(condition("cond1", false, "User is blocked"));
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.reasons[0].code, "PASS_NOT");
      assert.strictEqual(result.reasons[0].message, "Negated condition failed");
    });

    it("should fail when child passes", () => {
      const node = not(condition("cond1", true, "User is verified"));
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.reasons[0].code, "FAIL_NOT");
      assert.strictEqual(result.reasons[0].message, "Negated condition passed");
    });

    it("should include child details", () => {
      const node = not(condition("cond1", false, "Blocked"));
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
      // Should include NOT reason and child condition reason
      assert.ok(result.reasons.length >= 2);
      assert.ok(result.reasons.some(r => r.code === "PASS_NOT"));
      assert.ok(result.reasons.some(r => r.code === "FAIL_COND"));
    });

    it("should handle nested NOT nodes", () => {
      const node = not(not(condition("cond1", true)));
      const result = explainDecision(node);

      // Double negation should return original value
      assert.strictEqual(result.allowed, true);
    });

    it("should handle NOT with complex children", () => {
      const node = not(
        all(
          condition("cond1", true),
          condition("cond2", false, "Missing requirement")
        )
      );
      const result = explainDecision(node);

      // ALL fails, so NOT passes
      assert.strictEqual(result.allowed, true);
    });
  });

  describe("Mixed Nested Structures", () => {
    it("should handle complex nested policy", () => {
      const node = all(
        condition("user_active", true),
        any(
          condition("has_admin_role", true),
          all(
            condition("has_editor_role", true),
            condition("content_owned", true)
          )
        ),
        not(condition("is_suspended", false))
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
    });

    it("should handle complex nested policy with failure", () => {
      const node = all(
        condition("user_active", true),
        any(
          condition("has_admin_role", false),
          all(
            condition("has_editor_role", true),
            condition("content_owned", false, "Not owner")
          )
        ),
        not(condition("is_suspended", false))
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, false);
    });

    it("should handle deeply nested structure", () => {
      const node = all(
        all(
          all(
            condition("cond1", true),
            condition("cond2", true)
          ),
          condition("cond3", true)
        ),
        condition("cond4", true)
      );
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
    });
  });

  describe("Deterministic Ordering", () => {
    it("should produce identical output for equivalent trees", () => {
      const node1 = all(
        condition("cond1", true),
        condition("cond2", false),
        condition("cond3", true)
      );
      const node2 = all(
        condition("cond1", true),
        condition("cond2", false),
        condition("cond3", true)
      );

      const result1 = explainDecision(node1);
      const result2 = explainDecision(node2);

      assert.deepStrictEqual(result1, result2);
    });

    it("should sort reasons deterministically", () => {
      const node = all(
        condition("cond_z", false),
        condition("cond_a", false),
        condition("cond_m", false)
      );
      const result = explainDecision(node);

      // Reasons should be sorted by nodeId
      const nodeIds = result.reasons.map(r => r.nodeId);
      const sortedNodeIds = [...nodeIds].sort();
      assert.deepStrictEqual(nodeIds, sortedNodeIds);
    });

    it("should maintain consistent ordering across multiple calls", () => {
      const node = any(
        condition("cond3", true),
        condition("cond1", false),
        condition("cond2", false)
      );

      const results = Array.from({ length: 5 }, () => explainDecision(node));
      
      for (let i = 1; i < results.length; i++) {
        assert.deepStrictEqual(results[0], results[i]);
      }
    });
  });

  describe("Depth Limit Validation", () => {
    it("should accept tree within depth limit", () => {
      const node = all(
        condition("cond1", true),
        all(
          condition("cond2", true),
          all(
            condition("cond3", true),
            condition("cond4", true)
          )
        )
      );
      const result = explainDecision(node, { maxDepth: 10 });

      assert.strictEqual(result.allowed, true);
    });

    it("should reject tree exceeding depth limit", () => {
      // Create a tree with depth 51 (exceeds default of 50)
      let node: EvaluationNode = condition("deep", true);
      for (let i = 0; i < 51; i++) {
        node = all(node);
      }

      assert.throws(
        () => explainDecision(node),
        (error: Error) => {
          assert.ok(error instanceof ExplanationError);
          assert.ok(error.message.includes("maximum depth"));
          return true;
        }
      );
    });

    it("should respect custom depth limit", () => {
      let node: EvaluationNode = condition("deep", true);
      for (let i = 0; i < 5; i++) {
        node = all(node);
      }

      assert.throws(
        () => explainDecision(node, { maxDepth: 3 }),
        (error: Error) => {
          assert.ok(error instanceof ExplanationError);
          assert.ok(error.message.includes("maximum depth"));
          return true;
        }
      );
    });
  });

  describe("Node Count Limit Validation", () => {
    it("should accept tree within node count limit", () => {
      const children = Array.from({ length: 100 }, (_, i) =>
        condition(`cond${i}`, true)
      );
      const node = any(...children);
      const result = explainDecision(node, { maxNodes: 1000 });

      assert.strictEqual(result.allowed, true);
    });

    it("should reject tree exceeding node count limit", () => {
      // Create a tree with 1001 nodes (exceeds default of 1000)
      const children = Array.from({ length: 1001 }, (_, i) =>
        condition(`cond${i}`, true)
      );
      const node = any(...children);

      assert.throws(
        () => explainDecision(node),
        (error: Error) => {
          assert.ok(error instanceof ExplanationError);
          assert.ok(error.message.includes("maximum node count"));
          return true;
        }
      );
    });

    it("should respect custom node count limit", () => {
      const children = Array.from({ length: 11 }, (_, i) =>
        condition(`cond${i}`, true)
      );
      const node = any(...children);

      assert.throws(
        () => explainDecision(node, { maxNodes: 10 }),
        (error: Error) => {
          assert.ok(error instanceof ExplanationError);
          assert.ok(error.message.includes("maximum node count"));
          return true;
        }
      );
    });
  });

  describe("Malformed Input Rejection", () => {
    it("should reject condition node without id", () => {
      const node = { type: "condition" as const, id: "", passed: true };

      assert.throws(
        () => explainDecision(node),
        (error: Error) => {
          assert.ok(error instanceof ExplanationError);
          assert.ok(error.message.includes("non-empty id"));
          return true;
        }
      );
    });

    it("should reject condition node with invalid passed field", () => {
      const node = { type: "condition" as const, id: "cond1", passed: "true" as any };

      assert.throws(
        () => explainDecision(node),
        (error: Error) => {
          assert.ok(error instanceof ExplanationError);
          assert.ok(error.message.includes("boolean passed field"));
          return true;
        }
      );
    });

    it("should reject ALL node without children array", () => {
      const node = { type: "all" as const, children: null as any };

      assert.throws(
        () => explainDecision(node),
        (error: Error) => {
          assert.ok(error instanceof ExplanationError);
          assert.ok(error.message.includes("children array"));
          return true;
        }
      );
    });

    it("should reject ANY node without children array", () => {
      const node = { type: "any" as const, children: "invalid" as any };

      assert.throws(
        () => explainDecision(node),
        (error: Error) => {
          assert.ok(error instanceof ExplanationError);
          assert.ok(error.message.includes("children array"));
          return true;
        }
      );
    });

    it("should reject NOT node without child", () => {
      const node = { type: "not" as const, child: null as any };

      assert.throws(
        () => explainDecision(node),
        (error: Error) => {
          assert.ok(error instanceof ExplanationError);
          assert.ok(error.message.includes("must have a child"));
          return true;
        }
      );
    });

    it("should reject unknown node type", () => {
      const node = { type: "unknown" as any, children: [] };

      assert.throws(
        () => explainDecision(node),
        (error: Error) => {
          assert.ok(error instanceof ExplanationError);
          assert.ok(error.message.includes("Unknown node type"));
          return true;
        }
      );
    });
  });

  describe("Type Guards", () => {
    it("should identify condition nodes", () => {
      const node = condition("cond1", true);
      assert.strictEqual(isConditionNode(node), true);
      assert.strictEqual(isAllNode(node), false);
      assert.strictEqual(isAnyNode(node), false);
      assert.strictEqual(isNotNode(node), false);
    });

    it("should identify ALL nodes", () => {
      const node = all(condition("cond1", true));
      assert.strictEqual(isConditionNode(node), false);
      assert.strictEqual(isAllNode(node), true);
      assert.strictEqual(isAnyNode(node), false);
      assert.strictEqual(isNotNode(node), false);
    });

    it("should identify ANY nodes", () => {
      const node = any(condition("cond1", true));
      assert.strictEqual(isConditionNode(node), false);
      assert.strictEqual(isAllNode(node), false);
      assert.strictEqual(isAnyNode(node), true);
      assert.strictEqual(isNotNode(node), false);
    });

    it("should identify NOT nodes", () => {
      const node = not(condition("cond1", true));
      assert.strictEqual(isConditionNode(node), false);
      assert.strictEqual(isAllNode(node), false);
      assert.strictEqual(isAnyNode(node), false);
      assert.strictEqual(isNotNode(node), true);
    });
  });

  describe("Side-Effect Free", () => {
    it("should not modify input tree", () => {
      const originalNode = all(
        condition("cond1", true),
        condition("cond2", false)
      );
      
      // Store original values for comparison
      const originalType = originalNode.type;
      const originalChildren = originalNode.children.map(child => ({
        type: child.type,
        id: (child as any).id,
        passed: (child as any).passed,
        reason: (child as any).reason
      }));

      explainDecision(originalNode);

      // Verify no modifications
      assert.strictEqual(originalNode.type, originalType);
      assert.strictEqual(originalNode.children.length, originalChildren.length);
      for (let i = 0; i < originalNode.children.length; i++) {
        const child = originalNode.children[i];
        const originalChild = originalChildren[i];
        assert.strictEqual(child.type, originalChild.type);
        assert.strictEqual((child as any).id, originalChild.id);
        assert.strictEqual((child as any).passed, originalChild.passed);
        assert.strictEqual((child as any).reason, originalChild.reason);
      }
    });

    it("should produce independent results for each call", () => {
      const node = condition("cond1", true);
      const result1 = explainDecision(node);
      const result2 = explainDecision(node);

      // Results should be equal but not the same object
      assert.deepStrictEqual(result1, result2);
      assert.notStrictEqual(result1.reasons, result2.reasons);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty ALL node", () => {
      const node = all();
      const result = explainDecision(node);

      // Empty ALL should pass (vacuously true)
      assert.strictEqual(result.allowed, true);
    });

    it("should handle empty ANY node", () => {
      const node = any();
      const result = explainDecision(node);

      // Empty ANY should fail (no conditions to pass)
      assert.strictEqual(result.allowed, false);
    });

    it("should handle single child in ALL", () => {
      const node = all(condition("cond1", true));
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
    });

    it("should handle single child in ANY", () => {
      const node = any(condition("cond1", true));
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
    });

    it("should handle very long condition id", () => {
      const longId = "a".repeat(10000);
      const node = condition(longId, true);
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.reasons[0].nodeId, longId);
    });

    it("should handle special characters in condition id", () => {
      const node = condition("cond-with_special.chars", true);
      const result = explainDecision(node);

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.reasons[0].nodeId, "cond-with_special.chars");
    });
  });

  describe("Reason Code Stability", () => {
    it("should generate consistent reason codes", () => {
      const node = condition("cond1", true);
      const result = explainDecision(node);

      assert.strictEqual(result.reasons[0].code, "PASS_COND");
    });

    it("should generate different codes for different outcomes", () => {
      const passNode = condition("cond1", true);
      const failNode = condition("cond1", false);

      const passResult = explainDecision(passNode);
      const failResult = explainDecision(failNode);

      assert.strictEqual(passResult.reasons[0].code, "PASS_COND");
      assert.strictEqual(failResult.reasons[0].code, "FAIL_COND");
    });

    it("should generate appropriate codes for logical operators", () => {
      const allNode = all(condition("cond1", true));
      const anyNode = any(condition("cond1", true));
      const notNode = not(condition("cond1", false));

      const allResult = explainDecision(allNode);
      const anyResult = explainDecision(anyNode);
      const notResult = explainDecision(notNode);

      // ALL and ANY should have PASS codes as first reason
      assert.ok(allResult.reasons[0].code.startsWith("PASS_"));
      assert.ok(anyResult.reasons[0].code.startsWith("PASS_"));
      // NOT should have PASS_NOT as first reason due to sorting priority
      assert.strictEqual(notResult.reasons[0].code, "PASS_NOT");
    });
  });
});
