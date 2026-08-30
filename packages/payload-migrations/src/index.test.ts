import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AmbiguousMigrationError,
  CyclicMigrationError,
  DowngradeNotAllowedError,
  DuplicateMigrationError,
  MaxPathLengthError,
  MissingMigrationPathError,
  PayloadMigration,
  PayloadMigrationError,
  PayloadMigrationRegistry,
} from "./index.js";

const createMigration = <TInput = unknown, TOutput = unknown>(
  fromVersion: number,
  toVersion: number,
  transform: (input: TInput) => TOutput
): PayloadMigration<TInput, TOutput> => ({
  fromVersion,
  toVersion,
  migrate: transform,
});

describe("PayloadMigrationRegistry", () => {
  describe("direct one-step migration", () => {
    it("executes a single migration step", async () => {
      const registry = new PayloadMigrationRegistry();
      registry.register(
        createMigration(1, 2, (input: number) => (input as number) + 1)
      );

      const result = await registry.migrate(10, 1, 2);
      assert.equal(result, 11);
    });

    it("returns input unchanged when versions are equal", async () => {
      const registry = new PayloadMigrationRegistry();
      const result = await registry.migrate("hello", 1, 1);
      assert.equal(result, "hello");
    });
  });

  describe("multi-step migration chain", () => {
    it("executes migrations in correct order", async () => {
      const registry = new PayloadMigrationRegistry();
      registry.register(createMigration(1, 2, (n: number) => n + 1));
      registry.register(createMigration(2, 3, (n: number) => n * 2));
      registry.register(createMigration(3, 4, (n: number) => n - 1));

      const result = await registry.migrate(10, 1, 4);
      assert.equal(result, 21);
    });

    it("transforms payload types across steps", async () => {
      interface V1 {
        value: number;
      }
      interface V2 {
        text: string;
      }
      interface V3 {
        length: number;
      }

      const registry = new PayloadMigrationRegistry();
      registry.register(
        createMigration<V1, V2>(1, 2, (input) => ({
          text: String(input.value),
        }))
      );
      registry.register(
        createMigration<V2, V3>(2, 3, (input) => ({
          length: input.text.length,
        }))
      );

      const result = await registry.migrate({ value: 42 }, 1, 3) as V3;
      assert.equal(result.length, 2);
    });
  });

  describe("missing path", () => {
    it("rejects when no path exists", async () => {
      const registry = new PayloadMigrationRegistry();
      registry.register(createMigration(1, 2, (n: number) => n));

      await assert.rejects(
        async () => await registry.migrate(1, 1, 3),
        MissingMigrationPathError
      );
    });
  });

  describe("duplicate migration edge", () => {
    it("rejects duplicate registration", () => {
      const registry = new PayloadMigrationRegistry();
      registry.register(createMigration(1, 2, (n: number) => n));

      assert.throws(
        () => registry.register(createMigration(1, 2, (n: number) => n + 1)),
        DuplicateMigrationError
      );
    });
  });

  describe("cyclic graph", () => {
    it("rejects backward edges that would form a cycle", () => {
      const registry = new PayloadMigrationRegistry();
      registry.register(createMigration(1, 2, (n: number) => n));
      registry.register(createMigration(2, 3, (n: number) => n));

      assert.throws(
        () => registry.register(createMigration(3, 1, (n: number) => n)),
        DowngradeNotAllowedError
      );
    });

    it("detects self-loop", () => {
      const registry = new PayloadMigrationRegistry();
      assert.throws(
        () => registry.register(createMigration(1, 1, (n: number) => n)),
        PayloadMigrationError
      );
    });
  });

  describe("ambiguous paths", () => {
    it("rejects when multiple valid paths exist", () => {
      const registry = new PayloadMigrationRegistry();
      registry.register(createMigration(1, 2, (n: number) => n));
      registry.register(createMigration(2, 4, (n: number) => n));
      registry.register(createMigration(1, 3, (n: number) => n));
      registry.register(createMigration(3, 4, (n: number) => n));

      assert.throws(
        () => registry.findPath(1, 4),
        AmbiguousMigrationError
      );
    });
  });

  describe("deterministic behavior", () => {
    it("returns the same path regardless of registration order", () => {
      const registry1 = new PayloadMigrationRegistry();
      registry1.register(createMigration(1, 2, (n: number) => n));
      registry1.register(createMigration(2, 3, (n: number) => n));
      registry1.register(createMigration(3, 4, (n: number) => n));

      const registry2 = new PayloadMigrationRegistry();
      registry2.register(createMigration(3, 4, (n: number) => n));
      registry2.register(createMigration(1, 2, (n: number) => n));
      registry2.register(createMigration(2, 3, (n: number) => n));

      const path1 = registry1.findPath(1, 4);
      const path2 = registry2.findPath(1, 4);

      assert.deepEqual(path1, path2);
    });
  });

  describe("downgrade rejection", () => {
    it("rejects downgrade migrations", () => {
      const registry = new PayloadMigrationRegistry();
      assert.throws(
        () => registry.register(createMigration(2, 1, (n: number) => n)),
        DowngradeNotAllowedError
      );
    });
  });

  describe("max path length enforcement", () => {
    it("rejects paths exceeding max length", () => {
      const registry = new PayloadMigrationRegistry({ maxPathLength: 2 });

      registry.register(createMigration(1, 2, (n: number) => n));
      registry.register(createMigration(2, 3, (n: number) => n));
      registry.register(createMigration(3, 4, (n: number) => n));

      assert.throws(() => registry.findPath(1, 4), MissingMigrationPathError);
    });
  });

  describe("migration failure with context", () => {
    it("preserves original error with version context", async () => {
      const originalError = new Error("transform failed");
      const registry = new PayloadMigrationRegistry();
      registry.register(createMigration(1, 2, () => {
        throw originalError;
      }));
      registry.register(createMigration(2, 3, (n: number) => n));

      await assert.rejects(
        async () => await registry.migrate(1, 1, 3),
        (error: unknown) => {
          assert.ok(error instanceof PayloadMigrationError);
          assert.equal((error as PayloadMigrationError).fromVersion, 1);
          assert.equal((error as PayloadMigrationError).toVersion, 2);
          assert.equal((error as PayloadMigrationError).cause, originalError);
          return true;
        }
      );
    });

    it("stops immediately on failure", async () => {
      const calls: number[] = [];
      const registry = new PayloadMigrationRegistry();
      registry.register(
        createMigration(1, 2, () => {
          calls.push(1);
          throw new Error("fail");
        })
      );
      registry.register(
        createMigration(2, 3, () => {
          calls.push(2);
          return "ok";
        })
      );

      await assert.rejects(
        async () => await registry.migrate(1, 1, 3),
        PayloadMigrationError
      );

      assert.deepEqual(calls, [1]);
    });
  });

  describe("each migration executes exactly once", () => {
    it("prevents duplicate execution within a single migrate call", async () => {
      const calls: number[] = [];
      const registry = new PayloadMigrationRegistry();
      registry.register(
        createMigration(1, 2, () => {
          calls.push(1);
          return 1;
        })
      );
      registry.register(
        createMigration(2, 3, () => {
          calls.push(2);
          return 2;
        })
      );

      await registry.migrate(0, 1, 3);
      assert.deepEqual(calls, [1, 2]);
    });
  });

  describe("edge cases", () => {
    it("handles empty registry", () => {
      const registry = new PayloadMigrationRegistry();
      assert.throws(
        () => registry.findPath(1, 2),
        MissingMigrationPathError
      );
    });

    it("handles versions with no outgoing migrations", () => {
      const registry = new PayloadMigrationRegistry();
      registry.register(createMigration(2, 3, (n: number) => n));

      assert.throws(
        () => registry.findPath(1, 3),
        MissingMigrationPathError
      );
    });

    it("handles longer chains deterministically", async () => {
      const registry = new PayloadMigrationRegistry({ maxPathLength: 200 });
      for (let i = 1; i <= 100; i++) {
        if (i < 100) {
          registry.register(createMigration(i, i + 1, (n: number) => n + 1));
        }
      }

      const result = await registry.migrate(0, 1, 100);
      assert.equal(result, 99);
    });
  });
});
