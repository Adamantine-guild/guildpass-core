import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseVersion,
  parseConstraint,
  compareVersions,
  satisfiesConstraint,
  evaluate,
  isGreaterThan,
  isGreaterThanOrEqual,
  isLessThan,
  isLessThanOrEqual,
  isEqual,
  InvalidVersionError,
  InvalidConstraintError,
  type SemanticVersion,
  type VersionConstraint,
} from "./index.js";

describe("Semantic Version Parser and Constraint Evaluator", () => {
  describe("parseVersion", () => {
    it("parses valid semantic versions correctly", () => {
      const v1 = parseVersion("1.0.0");
      assert.equal(v1.major, 1);
      assert.equal(v1.minor, 0);
      assert.equal(v1.patch, 0);
      assert.equal(v1.raw, "1.0.0");

      const v2 = parseVersion("2.3.1");
      assert.equal(v2.major, 2);
      assert.equal(v2.minor, 3);
      assert.equal(v2.patch, 1);
      assert.equal(v2.raw, "2.3.1");

      const v3 = parseVersion("3.0.0-beta.1");
      assert.equal(v3.major, 3);
      assert.equal(v3.minor, 0);
      assert.equal(v3.patch, 0);
      assert.deepEqual(v3.prerelease, ["beta", 1]);
      assert.equal(v3.raw, "3.0.0-beta.1");
    });

    it("parses versions with prerelease identifiers", () => {
      const v1 = parseVersion("1.0.0-alpha");
      assert.deepEqual(v1.prerelease, ["alpha"]);

      const v2 = parseVersion("1.0.0-alpha.1");
      assert.deepEqual(v2.prerelease, ["alpha", 1]);

      const v3 = parseVersion("1.0.0-0.3.7");
      assert.deepEqual(v3.prerelease, [0, 3, 7]);

      const v4 = parseVersion("1.0.0-x.7.z.92");
      assert.deepEqual(v4.prerelease, ["x", 7, "z", 92]);
    });

    it("parses versions with build metadata", () => {
      const v1 = parseVersion("1.0.0+20130313144700");
      assert.deepEqual(v1.build, ["20130313144700"]);

      const v2 = parseVersion("1.0.0-alpha+001");
      assert.deepEqual(v2.prerelease, ["alpha"]);
      assert.deepEqual(v2.build, ["001"]);
    });

    it("rejects malformed versions", () => {
      assert.throws(
        () => parseVersion(""),
        (err: any) => err instanceof InvalidVersionError
      );

      assert.throws(
        () => parseVersion("invalid"),
        (err: any) => err instanceof InvalidVersionError
      );

      assert.throws(
        () => parseVersion("1.2.3.4"),
        (err: any) => err instanceof InvalidVersionError
      );
    });

    it("rejects non-string input", () => {
      assert.throws(
        () => parseVersion(null as any),
        (err: any) => err instanceof InvalidVersionError
      );
    });
  });

  describe("parseConstraint", () => {
    it("parses valid constraint strings", () => {
      const c1 = parseConstraint("=1.2.3");
      assert.equal(c1.operator, "=");
      assert.equal(c1.version.raw, "1.2.3");
      assert.equal(c1.raw, "=1.2.3");

      const c2 = parseConstraint(">1.2.3");
      assert.equal(c2.operator, ">");
      assert.equal(c2.version.raw, "1.2.3");

      const c3 = parseConstraint(">=1.2.3");
      assert.equal(c3.operator, ">=");
      assert.equal(c3.version.raw, "1.2.3");

      const c4 = parseConstraint("<2.0.0");
      assert.equal(c4.operator, "<");
      assert.equal(c4.version.raw, "2.0.0");

      const c5 = parseConstraint("<=2.0.0");
      assert.equal(c5.operator, "<=");
      assert.equal(c5.version.raw, "2.0.0");
    });

    it("parses constraints with prerelease versions", () => {
      const c1 = parseConstraint(">=1.0.0-alpha");
      assert.equal(c1.operator, ">=");
      assert.equal(c1.version.raw, "1.0.0-alpha");
    });

    it("handles whitespace in constraint strings", () => {
      const c1 = parseConstraint(" > 1.2.3 ");
      assert.equal(c1.operator, ">");
      assert.equal(c1.version.raw, "1.2.3");
      assert.equal(c1.raw, "> 1.2.3");
    });

    it("rejects malformed constraints", () => {
      assert.throws(
        () => parseConstraint(""),
        (err: any) => err instanceof InvalidConstraintError
      );

      assert.throws(
        () => parseConstraint("1.2.3"),
        (err: any) => err instanceof InvalidConstraintError
      );

      assert.throws(
        () => parseConstraint("==1.2.3"),
        (err: any) => err instanceof InvalidConstraintError
      );

      assert.throws(
        () => parseConstraint("!1.2.3"),
        (err: any) => err instanceof InvalidConstraintError
      );
    });

    it("rejects invalid operators", () => {
      assert.throws(
        () => parseConstraint(">>1.2.3"),
        (err: any) => err instanceof InvalidConstraintError
      );

      assert.throws(
        () => parseConstraint("<>1.2.3"),
        (err: any) => err instanceof InvalidConstraintError
      );
    });
  });

  describe("compareVersions", () => {
    it("correctly compares versions with numeric components", () => {
      const v1 = parseVersion("1.10.0");
      const v2 = parseVersion("1.9.0");
      assert.equal(compareVersions(v1, v2), 1); // 1.10.0 > 1.9.0
      assert.equal(compareVersions(v2, v1), -1); // 1.9.0 < 1.10.0
    });

    it("handles major version precedence", () => {
      const v1 = parseVersion("2.0.0");
      const v2 = parseVersion("1.9.9");
      assert.equal(compareVersions(v1, v2), 1);
      assert.equal(compareVersions(v2, v1), -1);
    });

    it("handles minor version precedence", () => {
      const v1 = parseVersion("1.5.0");
      const v2 = parseVersion("1.4.9");
      assert.equal(compareVersions(v1, v2), 1);
      assert.equal(compareVersions(v2, v1), -1);
    });

    it("handles patch version precedence", () => {
      const v1 = parseVersion("1.0.5");
      const v2 = parseVersion("1.0.4");
      assert.equal(compareVersions(v1, v2), 1);
      assert.equal(compareVersions(v2, v1), -1);
    });

    it("handles equal versions", () => {
      const v1 = parseVersion("1.2.3");
      const v2 = parseVersion("1.2.3");
      assert.equal(compareVersions(v1, v2), 0);
    });

    it("handles prerelease precedence according to semver spec", () => {
      const v1 = parseVersion("1.0.0-alpha");
      const v2 = parseVersion("1.0.0-alpha.1");
      const v3 = parseVersion("1.0.0-alpha.beta");
      const v4 = parseVersion("1.0.0-beta");
      const v5 = parseVersion("1.0.0-beta.2");
      const v6 = parseVersion("1.0.0-beta.11");
      const v7 = parseVersion("1.0.0-rc.1");
      const v8 = parseVersion("1.0.0");

      // Prerelease versions are less than the normal version
      assert.equal(compareVersions(v1, v8), -1);
      assert.equal(compareVersions(v8, v1), 1);

      // alpha < alpha.1 < alpha.beta < beta < beta.2 < beta.11 < rc.1
      assert.equal(compareVersions(v1, v2), -1);
      assert.equal(compareVersions(v2, v3), -1);
      assert.equal(compareVersions(v3, v4), -1);
      assert.equal(compareVersions(v4, v5), -1);
      assert.equal(compareVersions(v5, v6), -1);
      assert.equal(compareVersions(v6, v7), -1);
    });

    it("handles numeric identifiers in prerelease", () => {
      const v1 = parseVersion("1.0.0-1");
      const v2 = parseVersion("1.0.0-2");
      assert.equal(compareVersions(v1, v2), -1);
    });

    it("build metadata does not affect precedence", () => {
      const v1 = parseVersion("1.0.0+20130313144700");
      const v2 = parseVersion("1.0.0+20130313144701");
      assert.equal(compareVersions(v1, v2), 0);
    });
  });

  describe("Comparison functions", () => {
    it("isGreaterThan works correctly", () => {
      const v1 = parseVersion("1.10.0");
      const v2 = parseVersion("1.9.0");
      assert.equal(isGreaterThan(v1, v2), true);
      assert.equal(isGreaterThan(v2, v1), false);
      assert.equal(isGreaterThan(v1, v1), false);
    });

    it("isGreaterThanOrEqual works correctly", () => {
      const v1 = parseVersion("1.10.0");
      const v2 = parseVersion("1.9.0");
      const v3 = parseVersion("1.10.0");
      assert.equal(isGreaterThanOrEqual(v1, v2), true);
      assert.equal(isGreaterThanOrEqual(v2, v1), false);
      assert.equal(isGreaterThanOrEqual(v1, v3), true);
    });

    it("isLessThan works correctly", () => {
      const v1 = parseVersion("1.9.0");
      const v2 = parseVersion("1.10.0");
      assert.equal(isLessThan(v1, v2), true);
      assert.equal(isLessThan(v2, v1), false);
      assert.equal(isLessThan(v1, v1), false);
    });

    it("isLessThanOrEqual works correctly", () => {
      const v1 = parseVersion("1.9.0");
      const v2 = parseVersion("1.10.0");
      const v3 = parseVersion("1.9.0");
      assert.equal(isLessThanOrEqual(v1, v2), true);
      assert.equal(isLessThanOrEqual(v2, v1), false);
      assert.equal(isLessThanOrEqual(v1, v3), true);
    });

    it("isEqual works correctly", () => {
      const v1 = parseVersion("1.2.3");
      const v2 = parseVersion("1.2.3");
      const v3 = parseVersion("1.2.4");
      assert.equal(isEqual(v1, v2), true);
      assert.equal(isEqual(v1, v3), false);
    });
  });

  describe("satisfiesConstraint", () => {
    it("evaluates equality constraints", () => {
      const version = parseVersion("1.2.3");
      const constraint = parseConstraint("=1.2.3");
      assert.equal(satisfiesConstraint(version, constraint), true);

      const version2 = parseVersion("1.2.4");
      assert.equal(satisfiesConstraint(version2, constraint), false);
    });

    it("evaluates greater-than constraints", () => {
      const version = parseVersion("1.2.4");
      const constraint = parseConstraint(">1.2.3");
      assert.equal(satisfiesConstraint(version, constraint), true);

      const version2 = parseVersion("1.2.3");
      assert.equal(satisfiesConstraint(version2, constraint), false);

      const version3 = parseVersion("1.2.2");
      assert.equal(satisfiesConstraint(version3, constraint), false);
    });

    it("evaluates greater-than-or-equal constraints", () => {
      const version = parseVersion("1.2.3");
      const constraint = parseConstraint(">=1.2.3");
      assert.equal(satisfiesConstraint(version, constraint), true);

      const version2 = parseVersion("1.2.4");
      assert.equal(satisfiesConstraint(version2, constraint), true);

      const version3 = parseVersion("1.2.2");
      assert.equal(satisfiesConstraint(version3, constraint), false);
    });

    it("evaluates less-than constraints", () => {
      const version = parseVersion("1.2.2");
      const constraint = parseConstraint("<1.2.3");
      assert.equal(satisfiesConstraint(version, constraint), true);

      const version2 = parseVersion("1.2.3");
      assert.equal(satisfiesConstraint(version2, constraint), false);

      const version3 = parseVersion("1.2.4");
      assert.equal(satisfiesConstraint(version3, constraint), false);
    });

    it("evaluates less-than-or-equal constraints", () => {
      const version = parseVersion("1.2.3");
      const constraint = parseConstraint("<=1.2.3");
      assert.equal(satisfiesConstraint(version, constraint), true);

      const version2 = parseVersion("1.2.2");
      assert.equal(satisfiesConstraint(version2, constraint), true);

      const version3 = parseVersion("1.2.4");
      assert.equal(satisfiesConstraint(version3, constraint), false);
    });

    it("handles prerelease versions in constraints", () => {
      const version = parseVersion("1.0.0-alpha.1");
      const constraint = parseConstraint(">=1.0.0-alpha");
      assert.equal(satisfiesConstraint(version, constraint), true);

      const version2 = parseVersion("1.0.0");
      assert.equal(satisfiesConstraint(version2, constraint), true);
    });

    it("handles numeric version comparisons correctly", () => {
      const version = parseVersion("1.10.0");
      const constraint = parseConstraint(">1.9.0");
      assert.equal(satisfiesConstraint(version, constraint), true);
    });
  });

  describe("evaluate", () => {
    it("combines parsing and evaluation in a single call", () => {
      assert.equal(evaluate("1.2.3", "=1.2.3"), true);
      assert.equal(evaluate("1.2.4", ">1.2.3"), true);
      assert.equal(evaluate("1.2.3", ">=1.2.3"), true);
      assert.equal(evaluate("1.2.2", "<1.2.3"), true);
      assert.equal(evaluate("1.2.3", "<=1.2.3"), true);
    });

    it("throws InvalidVersionError for invalid version strings", () => {
      assert.throws(
        () => evaluate("invalid", ">=1.0.0"),
        (err: any) => err instanceof InvalidVersionError
      );
    });

    it("throws InvalidConstraintError for invalid constraint strings", () => {
      assert.throws(
        () => evaluate("1.0.0", "invalid"),
        (err: any) => err instanceof InvalidConstraintError
      );
    });
  });

  describe("Deterministic evaluation", () => {
    it("produces consistent results across multiple evaluations", () => {
      const version = parseVersion("1.2.3");
      const constraint = parseConstraint(">=1.0.0");

      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(satisfiesConstraint(version, constraint));
      }

      assert.equal(results.every((r) => r === true), true);
    });

    it("compareVersions is deterministic", () => {
      const v1 = parseVersion("1.10.0");
      const v2 = parseVersion("1.9.0");

      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(compareVersions(v1, v2));
      }

      assert.equal(results.every((r) => r === 1), true);
    });
  });

  describe("Strong typing", () => {
    it("SemanticVersion interface has correct types", () => {
      const version: SemanticVersion = parseVersion("1.2.3");
      assert.equal(typeof version.major, "number");
      assert.equal(typeof version.minor, "number");
      assert.equal(typeof version.patch, "number");
      assert.equal(typeof version.raw, "string");
      assert.equal(Array.isArray(version.prerelease), true);
      assert.equal(Array.isArray(version.build), true);
    });

    it("VersionConstraint interface has correct types", () => {
      const constraint: VersionConstraint = parseConstraint(">=1.2.3");
      assert.equal(typeof constraint.operator, "string");
      assert.equal(typeof constraint.raw, "string");
      assert.equal(typeof constraint.version, "object");
    });
  });

  describe("Boundary cases", () => {
    it("handles version 0.0.0", () => {
      const version = parseVersion("0.0.0");
      assert.equal(version.major, 0);
      assert.equal(version.minor, 0);
      assert.equal(version.patch, 0);
    });

    it("handles large version numbers", () => {
      const version = parseVersion("999.999.999");
      assert.equal(version.major, 999);
      assert.equal(version.minor, 999);
      assert.equal(version.patch, 999);
    });

    it("handles version with numeric prerelease identifiers", () => {
      const version = parseVersion("1.0.0-alpha.1");
      assert.deepEqual(version.prerelease, ["alpha", 1]);
    });

    it("handles constraint with exact version match", () => {
      const version = parseVersion("1.2.3");
      const constraint = parseConstraint("=1.2.3");
      assert.equal(satisfiesConstraint(version, constraint), true);
    });

    it("handles boundary comparisons", () => {
      const v1 = parseVersion("1.0.0");
      const v2 = parseVersion("1.0.1");
      const v3 = parseVersion("1.1.0");
      const v4 = parseVersion("2.0.0");

      assert.equal(isLessThan(v1, v2), true);
      assert.equal(isLessThan(v2, v3), true);
      assert.equal(isLessThan(v3, v4), true);
    });
  });

  describe("Prerelease edge cases", () => {
    it("handles empty prerelease array for stable versions", () => {
      const version = parseVersion("1.0.0");
      assert.deepEqual(version.prerelease, []);
    });

    it("handles prerelease with mixed types", () => {
      const version = parseVersion("1.0.0-alpha.1.beta.2");
      assert.deepEqual(version.prerelease, ["alpha", 1, "beta", 2]);
    });

    it("correctly compares prerelease with different identifiers", () => {
      const v1 = parseVersion("1.0.0-alpha");
      const v2 = parseVersion("1.0.0-beta");
      assert.equal(isLessThan(v1, v2), true);
    });

    it("handles prerelease constraint with stable version", () => {
      const version = parseVersion("1.0.0");
      const constraint = parseConstraint(">=1.0.0-alpha");
      assert.equal(satisfiesConstraint(version, constraint), true);
    });
  });
});
