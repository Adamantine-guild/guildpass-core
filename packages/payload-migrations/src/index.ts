export interface PayloadMigration<TInput = unknown, TOutput = unknown> {
  fromVersion: number;
  toVersion: number;
  migrate(input: TInput): TOutput;
}

export interface MigrationPlan<TInput = unknown, TOutput = unknown> {
  steps: PayloadMigration<TInput, TOutput>[];
  startVersion: number;
  targetVersion: number;
}

export interface MigrationRegistryConfig {
  maxPathLength?: number;
}

export class PayloadMigrationError extends Error {
  constructor(
    message: string,
    public readonly fromVersion: number,
    public readonly toVersion: number,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "PayloadMigrationError";
  }
}

export class MigrationPathError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = "MigrationPathError";
  }
}

export class AmbiguousMigrationError extends MigrationPathError {
  constructor(message: string, public readonly paths: number[][]) {
    super(message);
    this.name = "AmbiguousMigrationError";
  }
}

export class CyclicMigrationError extends MigrationPathError {
  constructor(message: string) {
    super(message);
    this.name = "CyclicMigrationError";
  }
}

export class DuplicateMigrationError extends MigrationPathError {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateMigrationError";
  }
}

export class MaxPathLengthError extends MigrationPathError {
  constructor(message: string) {
    super(message);
    this.name = "MaxPathLengthError";
  }
}

export class DowngradeNotAllowedError extends MigrationPathError {
  constructor(message: string) {
    super(message);
    this.name = "DowngradeNotAllowedError";
  }
}

export class MissingMigrationPathError extends MigrationPathError {
  constructor(message: string) {
    super(message);
    this.name = "MissingMigrationPathError";
  }
}

export class PayloadMigrationRegistry {
  private migrations: PayloadMigration[] = [];
  private adjacency = new Map<number, PayloadMigration[]>();
  private registeredEdges = new Map<string, PayloadMigration>();

  constructor(private config: MigrationRegistryConfig = {}) {
    this.config.maxPathLength = config.maxPathLength ?? 50;
  }

  register<TInput = unknown, TOutput = unknown>(
    migration: PayloadMigration<TInput, TOutput>
  ): void {
    const { fromVersion, toVersion } = migration;

    if (fromVersion === toVersion) {
      throw new PayloadMigrationError(
        `Self-migration is not allowed: version ${fromVersion}`,
        fromVersion,
        toVersion
      );
    }

    const edgeKey = `${fromVersion}->${toVersion}`;

    if (this.registeredEdges.has(edgeKey)) {
      const existing = this.registeredEdges.get(edgeKey)!;
      throw new DuplicateMigrationError(
        `Duplicate migration edge: ${fromVersion} -> ${toVersion}`
      );
    }

    if (toVersion < fromVersion) {
      throw new DowngradeNotAllowedError(
        `Downgrade migration not allowed: ${fromVersion} -> ${toVersion}`
      );
    }

    this.migrations.push(migration);
    this.registeredEdges.set(edgeKey, migration);

    const list = this.adjacency.get(fromVersion) ?? [];
    list.push(migration);
    this.adjacency.set(fromVersion, list);
  }

  findPath(fromVersion: number, toVersion: number): number[] {
    if (fromVersion === toVersion) {
      return [];
    }

    this.detectCycles();

    const maxPathLength = this.config.maxPathLength!;
    const allPaths: number[][] = [];
    const visited = new Set<number>();
    const path: number[] = [];

    const dfs = (current: number, depth: number): void => {
      visited.add(current);
      path.push(current);

      const outgoing = this.adjacency.get(current) ?? [];

      for (const migration of outgoing) {
        if (migration.toVersion === toVersion) {
          if (depth < maxPathLength) {
            allPaths.push([...path, migration.toVersion]);
          }
        } else if (!visited.has(migration.toVersion) && depth < maxPathLength) {
          dfs(migration.toVersion, depth + 1);
        }
      }

      path.pop();
      visited.delete(current);
    };

    dfs(fromVersion, 0);

    if (allPaths.length === 0) {
      throw new MissingMigrationPathError(
        `No migration path found from version ${fromVersion} to ${toVersion}`
      );
    }

    const uniquePaths = this.uniquePaths(allPaths);

    if (uniquePaths.length > 1) {
      throw new AmbiguousMigrationError(
        `Ambiguous migration path from ${fromVersion} to ${toVersion}: found ${uniquePaths.length} valid paths`,
        uniquePaths
      );
    }

    return uniquePaths[0];
  }

  async migrate<TInput = unknown, TOutput = unknown>(
    input: TInput,
    fromVersion: number,
    toVersion: number
  ): Promise<TOutput> {
    if (fromVersion === toVersion) {
      return input as unknown as TOutput;
    }

    const path = this.findPath(fromVersion, toVersion);
    let current: unknown = input;
    const executed = new Set<PayloadMigration>();

    for (let i = 0; i < path.length - 1; i++) {
      const segmentFrom = path[i];
      const segmentTo = path[i + 1];
      const outgoing = this.adjacency.get(segmentFrom) ?? [];
      const migration = outgoing.find((m) => m.toVersion === segmentTo);

      if (!migration) {
        throw new MissingMigrationPathError(
          `Missing migration edge for path segment: ${segmentFrom} -> ${segmentTo}`
        );
      }

      if (executed.has(migration)) {
        throw new PayloadMigrationError(
          `Migration executed more than once: ${segmentFrom} -> ${segmentTo}`,
          segmentFrom,
          segmentTo
        );
      }

      executed.add(migration);

      try {
        current = migration.migrate(current);
      } catch (error) {
        throw new PayloadMigrationError(
          `Migration failed from version ${segmentFrom} to ${segmentTo}`,
          segmentFrom,
          segmentTo,
          error instanceof Error ? error : undefined
        );
      }
    }

    return current as unknown as TOutput;
  }

  getRegisteredMigrations(): PayloadMigration[] {
    return [...this.migrations];
  }

  private detectCycles(): void {
    const visited = new Set<number>();
    const stack = new Set<number>();

    const dfs = (node: number): void => {
      visited.add(node);
      stack.add(node);

      const outgoing = this.adjacency.get(node) ?? [];
      for (const migration of outgoing) {
        if (stack.has(migration.toVersion)) {
          throw new CyclicMigrationError(
            `Cycle detected in migration graph involving version ${migration.toVersion}`
          );
        }
        if (!visited.has(migration.toVersion)) {
          dfs(migration.toVersion);
        }
      }

      stack.delete(node);
    };

    const allVersions = new Set<number>();
    for (const [from, migrations] of this.adjacency) {
      allVersions.add(from);
      for (const m of migrations) {
        allVersions.add(m.toVersion);
      }
    }

    for (const version of allVersions) {
      if (!visited.has(version)) {
        dfs(version);
      }
    }
  }

  private uniquePaths(paths: number[][]): number[][] {
    const seen = new Set<string>();
    const unique: number[][] = [];

    for (const path of paths) {
      const key = path.join("->");
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(path);
      }
    }

    return unique;
  }
}
