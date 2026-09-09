import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PermissionInheritanceResolver,
  CycleDetectedError,
  MissingRoleError,
  DepthLimitExceededError,
  GraphSizeLimitExceededError,
  InvalidRoleError,
  type RoleNode,
} from "./index.js";

describe("PermissionInheritanceResolver", () => {
  describe("Direct Permissions", () => {
    it("resolves direct permissions correctly", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "admin", permissions: ["read", "write", "delete"], inherits: [] },
      ];

      const result = resolver.resolve(roles, "admin");

      assert.equal(result.roleId, "admin");
      assert.deepEqual(result.effectivePermissions, ["delete", "read", "write"]);
      assert.deepEqual(result.inheritancePath, ["admin"]);
    });

    it("handles role with no permissions", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [{ id: "guest", permissions: [], inherits: [] }];

      const result = resolver.resolve(roles, "guest");

      assert.equal(result.roleId, "guest");
      assert.deepEqual(result.effectivePermissions, []);
      assert.deepEqual(result.inheritancePath, ["guest"]);
    });
  });

  describe("Single-Level Inheritance", () => {
    it("resolves single-level inheritance correctly", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "admin", permissions: ["delete"], inherits: [] },
        { id: "moderator", permissions: ["edit"], inherits: ["admin"] },
      ];

      const result = resolver.resolve(roles, "moderator");

      assert.equal(result.roleId, "moderator");
      assert.deepEqual(result.effectivePermissions, ["delete", "edit"]);
      assert.deepEqual(result.inheritancePath, ["moderator", "admin"]);
    });

    it("includes both direct and inherited permissions", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "base", permissions: ["read"], inherits: [] },
        { id: "extended", permissions: ["write"], inherits: ["base"] },
      ];

      const result = resolver.resolve(roles, "extended");

      assert.deepEqual(result.effectivePermissions, ["read", "write"]);
    });
  });

  describe("Multi-Level Inheritance", () => {
    it("resolves multi-level inheritance correctly", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "level1", permissions: ["perm1"], inherits: [] },
        { id: "level2", permissions: ["perm2"], inherits: ["level1"] },
        { id: "level3", permissions: ["perm3"], inherits: ["level2"] },
      ];

      const result = resolver.resolve(roles, "level3");

      assert.deepEqual(result.effectivePermissions, ["perm1", "perm2", "perm3"]);
      assert.deepEqual(result.inheritancePath, ["level3", "level2", "level1"]);
    });

    it("handles deep inheritance chains", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "r1", permissions: ["p1"], inherits: [] },
        { id: "r2", permissions: ["p2"], inherits: ["r1"] },
        { id: "r3", permissions: ["p3"], inherits: ["r2"] },
        { id: "r4", permissions: ["p4"], inherits: ["r3"] },
        { id: "r5", permissions: ["p5"], inherits: ["r4"] },
      ];

      const result = resolver.resolve(roles, "r5");

      assert.deepEqual(result.effectivePermissions, ["p1", "p2", "p3", "p4", "p5"]);
    });
  });

  describe("Multiple Inheritance", () => {
    it("resolves multiple inheritance correctly", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "reader", permissions: ["read"], inherits: [] },
        { id: "writer", permissions: ["write"], inherits: [] },
        { id: "admin", permissions: ["delete"], inherits: ["reader", "writer"] },
      ];

      const result = resolver.resolve(roles, "admin");

      assert.deepEqual(result.effectivePermissions, ["delete", "read", "write"]);
    });

    it("handles diamond inheritance pattern", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "base", permissions: ["read"], inherits: [] },
        { id: "role_a", permissions: ["write"], inherits: ["base"] },
        { id: "role_b", permissions: ["delete"], inherits: ["base"] },
        { id: "combined", permissions: ["admin"], inherits: ["role_a", "role_b"] },
      ];

      const result = resolver.resolve(roles, "combined");

      // Should include all permissions from all paths, but base only once
      assert.deepEqual(result.effectivePermissions, ["admin", "delete", "read", "write"]);
    });

    it("deduplicates permissions from multiple paths", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "base", permissions: ["read", "write"], inherits: [] },
        { id: "role_a", permissions: ["read"], inherits: ["base"] },
        { id: "role_b", permissions: ["write"], inherits: ["base"] },
        { id: "combined", permissions: [], inherits: ["role_a", "role_b"] },
      ];

      const result = resolver.resolve(roles, "combined");

      // read and write should appear only once despite being inherited via multiple paths
      assert.deepEqual(result.effectivePermissions, ["read", "write"]);
    });
  });

  describe("Permission Deduplication", () => {
    it("removes duplicate permissions from same role", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "role", permissions: ["read", "read", "write"], inherits: [] },
      ];

      const result = resolver.resolve(roles, "role");

      assert.deepEqual(result.effectivePermissions, ["read", "write"]);
    });

    it("removes duplicate permissions across inheritance chain", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "base", permissions: ["read"], inherits: [] },
        { id: "child", permissions: ["read", "write"], inherits: ["base"] },
      ];

      const result = resolver.resolve(roles, "child");

      assert.deepEqual(result.effectivePermissions, ["read", "write"]);
    });
  });

  describe("Cycle Detection", () => {
    it("detects simple cycle", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "a", permissions: [], inherits: ["b"] },
        { id: "b", permissions: [], inherits: ["a"] },
      ];

      assert.throws(() => resolver.resolve(roles, "a"), CycleDetectedError);
    });

    it("detects complex cycle", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "a", permissions: [], inherits: ["b"] },
        { id: "b", permissions: [], inherits: ["c"] },
        { id: "c", permissions: [], inherits: ["a"] },
      ];

      assert.throws(() => resolver.resolve(roles, "a"), CycleDetectedError);
    });

    it("detects self-referential cycle", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "a", permissions: [], inherits: ["a"] },
      ];

      assert.throws(() => resolver.resolve(roles, "a"), CycleDetectedError);
    });

    it("provides cycle information in error", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "a", permissions: [], inherits: ["b"] },
        { id: "b", permissions: [], inherits: ["a"] },
      ];

      try {
        resolver.resolve(roles, "a");
        assert.fail("Should have thrown CycleDetectedError");
      } catch (error) {
        assert.ok(error instanceof CycleDetectedError);
        assert.ok((error as CycleDetectedError).cycle.includes("a"));
        assert.ok((error as CycleDetectedError).cycle.includes("b"));
      }
    });
  });

  describe("Missing Role Detection", () => {
    it("rejects references to unknown parent roles", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "child", permissions: [], inherits: ["missing_parent"] },
      ];

      assert.throws(() => resolver.resolve(roles, "child"), MissingRoleError);
    });

    it("provides missing role information in error", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "child", permissions: [], inherits: ["missing_parent"] },
      ];

      try {
        resolver.resolve(roles, "child");
        assert.fail("Should have thrown MissingRoleError");
      } catch (error) {
        assert.ok(error instanceof MissingRoleError);
        assert.equal((error as MissingRoleError).roleId, "child");
        assert.equal((error as MissingRoleError).missingParentId, "missing_parent");
      }
    });

    it("rejects resolution of non-existent role", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "existing", permissions: [], inherits: [] },
      ];

      assert.throws(() => resolver.resolve(roles, "nonexistent"), InvalidRoleError);
    });
  });

  describe("Deterministic Ordering", () => {
    it("returns permissions in deterministic alphabetical order", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "role", permissions: ["zebra", "apple", "banana"], inherits: [] },
      ];

      const result = resolver.resolve(roles, "role");

      assert.deepEqual(result.effectivePermissions, ["apple", "banana", "zebra"]);
    });

    it("maintains consistent ordering across multiple resolutions", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "base", permissions: ["z"], inherits: [] },
        { id: "mid", permissions: ["y"], inherits: ["base"] },
        { id: "top", permissions: ["x"], inherits: ["mid"] },
      ];

      const result1 = resolver.resolve(roles, "top");
      const result2 = resolver.resolve(roles, "top");

      assert.deepEqual(result1.effectivePermissions, result2.effectivePermissions);
    });
  });

  describe("Depth Limits", () => {
    it("enforces configurable depth limit", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "r1", permissions: [], inherits: [] },
        { id: "r2", permissions: [], inherits: ["r1"] },
        { id: "r3", permissions: [], inherits: ["r2"] },
        { id: "r4", permissions: [], inherits: ["r3"] },
      ];

      assert.throws(
        () => resolver.resolve(roles, "r4", { maxDepth: 2 }),
        DepthLimitExceededError
      );
    });

    it("allows resolutions within depth limit", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "r1", permissions: ["p1"], inherits: [] },
        { id: "r2", permissions: ["p2"], inherits: ["r1"] },
        { id: "r3", permissions: ["p3"], inherits: ["r2"] },
      ];

      const result = resolver.resolve(roles, "r3", { maxDepth: 5 });

      assert.deepEqual(result.effectivePermissions, ["p1", "p2", "p3"]);
    });

    it("provides depth limit information in error", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "r1", permissions: [], inherits: [] },
        { id: "r2", permissions: [], inherits: ["r1"] },
        { id: "r3", permissions: [], inherits: ["r2"] },
      ];

      try {
        resolver.resolve(roles, "r3", { maxDepth: 1 });
        assert.fail("Should have thrown DepthLimitExceededError");
      } catch (error) {
        assert.ok(error instanceof DepthLimitExceededError);
        assert.equal((error as DepthLimitExceededError).maxDepth, 1);
      }
    });
  });

  describe("Graph Size Limits", () => {
    it("enforces configurable graph size limit", () => {
      const resolver = new PermissionInheritanceResolver({ defaultMaxRoles: 2 });
      const roles: RoleNode[] = [
        { id: "r1", permissions: [], inherits: [] },
        { id: "r2", permissions: [], inherits: [] },
        { id: "r3", permissions: [], inherits: [] },
      ];

      assert.throws(() => resolver.resolve(roles, "r1"), GraphSizeLimitExceededError);
    });

    it("allows resolutions within graph size limit", () => {
      const resolver = new PermissionInheritanceResolver({ defaultMaxRoles: 5 });
      const roles: RoleNode[] = [
        { id: "r1", permissions: ["p1"], inherits: [] },
        { id: "r2", permissions: ["p2"], inherits: [] },
      ];

      const result = resolver.resolve(roles, "r1");

      assert.deepEqual(result.effectivePermissions, ["p1"]);
    });

    it("respects per-call maxRoles option", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "r1", permissions: [], inherits: [] },
        { id: "r2", permissions: [], inherits: [] },
        { id: "r3", permissions: [], inherits: [] },
      ];

      assert.throws(
        () => resolver.resolve(roles, "r1", { maxRoles: 2 }),
        GraphSizeLimitExceededError
      );
    });
  });

  describe("Role Validation", () => {
    it("rejects roles with empty ID", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "", permissions: [], inherits: [] },
      ];

      assert.throws(() => resolver.resolve(roles, ""), InvalidRoleError);
    });

    it("rejects roles with non-array permissions", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "role", permissions: "not-an-array" as unknown as string[], inherits: [] },
      ];

      assert.throws(() => resolver.resolve(roles, "role"), InvalidRoleError);
    });

    it("rejects roles with non-array inherits", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "role", permissions: [], inherits: "not-an-array" as unknown as string[] },
      ];

      assert.throws(() => resolver.resolve(roles, "role"), InvalidRoleError);
    });

    it("rejects non-string permissions", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "role", permissions: [123 as unknown as string], inherits: [] },
      ];

      assert.throws(() => resolver.resolve(roles, "role"), InvalidRoleError);
    });

    it("rejects non-string inherited role IDs", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "role", permissions: [], inherits: [123 as unknown as string] },
      ];

      assert.throws(() => resolver.resolve(roles, "role"), InvalidRoleError);
    });
  });

  describe("Multiple Role Resolution", () => {
    it("resolves permissions for multiple roles", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "admin", permissions: ["delete"], inherits: [] },
        { id: "user", permissions: ["read"], inherits: [] },
      ];

      const results = resolver.resolveMultiple(roles, ["admin", "user"]);

      assert.equal(results.size, 2);
      assert.deepEqual(results.get("admin")?.effectivePermissions, ["delete"]);
      assert.deepEqual(results.get("user")?.effectivePermissions, ["read"]);
    });

    it("propagates errors in multiple resolution", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "admin", permissions: [], inherits: ["missing"] },
      ];

      assert.throws(() => resolver.resolveMultiple(roles, ["admin"]), MissingRoleError);
    });
  });

  describe("Map Input Support", () => {
    it("accepts Map input for roles", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles = new Map<string, RoleNode>([
        ["admin", { id: "admin", permissions: ["delete"], inherits: [] }],
      ]);

      const result = resolver.resolve(roles, "admin");

      assert.deepEqual(result.effectivePermissions, ["delete"]);
    });

    it("handles Map with complex inheritance", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles = new Map<string, RoleNode>([
        ["base", { id: "base", permissions: ["read"], inherits: [] }],
        ["child", { id: "child", permissions: ["write"], inherits: ["base"] }],
      ]);

      const result = resolver.resolve(roles, "child");

      assert.deepEqual(result.effectivePermissions, ["read", "write"]);
    });
  });

  describe("Edge Cases", () => {
    it("handles empty role array", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [];

      assert.throws(() => resolver.resolve(roles, "any"), InvalidRoleError);
    });

    it("handles role with empty inherits array", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "standalone", permissions: ["read"], inherits: [] },
      ];

      const result = resolver.resolve(roles, "standalone");

      assert.deepEqual(result.effectivePermissions, ["read"]);
      assert.deepEqual(result.inheritancePath, ["standalone"]);
    });

    it("handles complex inheritance with multiple levels and branches", () => {
      const resolver = new PermissionInheritanceResolver();
      const roles: RoleNode[] = [
        { id: "base", permissions: ["base_perm"], inherits: [] },
        { id: "branch1", permissions: ["branch1_perm"], inherits: ["base"] },
        { id: "branch2", permissions: ["branch2_perm"], inherits: ["base"] },
        { id: "leaf1", permissions: ["leaf1_perm"], inherits: ["branch1"] },
        { id: "leaf2", permissions: ["leaf2_perm"], inherits: ["branch2"] },
        { id: "combined", permissions: ["combined_perm"], inherits: ["leaf1", "leaf2"] },
      ];

      const result = resolver.resolve(roles, "combined");

      assert.deepEqual(result.effectivePermissions, [
        "base_perm",
        "branch1_perm",
        "branch2_perm",
        "combined_perm",
        "leaf1_perm",
        "leaf2_perm",
      ]);
      // Check that the path contains all expected roles (order may vary due to deduplication)
      assert.ok(result.inheritancePath.includes("combined"));
      assert.ok(result.inheritancePath.includes("leaf1"));
      assert.ok(result.inheritancePath.includes("leaf2"));
      assert.ok(result.inheritancePath.includes("branch1"));
      assert.ok(result.inheritancePath.includes("branch2"));
      assert.ok(result.inheritancePath.includes("base"));
    });
  });
});
