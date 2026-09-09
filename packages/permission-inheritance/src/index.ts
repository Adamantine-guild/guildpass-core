export interface RoleNode {
  id: string;
  permissions: string[];
  inherits: string[];
}

export interface ResolveOptions {
  maxDepth?: number;
  maxRoles?: number;
}

export interface ResolveResult {
  roleId: string;
  effectivePermissions: string[];
  inheritancePath: string[];
}

export class CycleDetectedError extends Error {
  constructor(
    public cycle: string[],
    message = "Cycle detected in role inheritance graph"
  ) {
    super(message);
    this.name = "CycleDetectedError";
  }
}

export class MissingRoleError extends Error {
  constructor(
    public roleId: string,
    public missingParentId: string,
    message = "Missing inherited role"
  ) {
    super(message);
    this.name = "MissingRoleError";
  }
}

export class DepthLimitExceededError extends Error {
  constructor(
    public roleId: string,
    public maxDepth: number,
    message = "Maximum inheritance depth exceeded"
  ) {
    super(message);
    this.name = "DepthLimitExceededError";
  }
}

export class GraphSizeLimitExceededError extends Error {
  constructor(
    public maxRoles: number,
    message = "Maximum number of roles exceeded"
  ) {
    super(message);
    this.name = "GraphSizeLimitExceededError";
  }
}

export class InvalidRoleError extends Error {
  constructor(
    public roleId: string,
    message = "Invalid role definition"
  ) {
    super(message);
    this.name = "InvalidRoleError";
  }
}

export interface PermissionInheritanceResolverOptions {
  defaultMaxDepth?: number;
  defaultMaxRoles?: number;
}

export class PermissionInheritanceResolver {
  private readonly defaultMaxDepth: number;
  private readonly defaultMaxRoles: number;

  constructor(options: PermissionInheritanceResolverOptions = {}) {
    this.defaultMaxDepth = options.defaultMaxDepth ?? 100;
    this.defaultMaxRoles = options.defaultMaxRoles ?? 1000;
  }

  /**
   * Validate role definitions
   */
  private validateRoles(roles: Map<string, RoleNode>): void {
    if (roles.size > this.defaultMaxRoles) {
      throw new GraphSizeLimitExceededError(this.defaultMaxRoles);
    }

    for (const [id, role] of roles.entries()) {
      if (!id || typeof id !== "string" || id.trim().length === 0) {
        throw new InvalidRoleError(id, "Role ID must be a non-empty string");
      }
      if (!Array.isArray(role.permissions)) {
        throw new InvalidRoleError(id, "Role permissions must be an array");
      }
      if (!Array.isArray(role.inherits)) {
        throw new InvalidRoleError(id, "Role inherits must be an array");
      }
      for (const perm of role.permissions) {
        if (typeof perm !== "string") {
          throw new InvalidRoleError(id, "All permissions must be strings");
        }
      }
      for (const parent of role.inherits) {
        if (typeof parent !== "string") {
          throw new InvalidRoleError(id, "All inherited role IDs must be strings");
        }
      }
    }
  }

  /**
   * Detect cycles in the inheritance graph using DFS
   */
  private detectCycle(
    roles: Map<string, RoleNode>,
    startRoleId: string,
    visited: Set<string> = new Set(),
    path: string[] = []
  ): string[] | null {
    if (path.includes(startRoleId)) {
      const cycleStart = path.indexOf(startRoleId);
      return [...path.slice(cycleStart), startRoleId];
    }

    if (visited.has(startRoleId)) {
      return null;
    }

    visited.add(startRoleId);
    const newPath = [...path, startRoleId];

    const role = roles.get(startRoleId);
    if (!role) {
      return null;
    }

    for (const parentId of role.inherits) {
      const cycle = this.detectCycle(roles, parentId, visited, newPath);
      if (cycle) {
        return cycle;
      }
    }

    return null;
  }

  /**
   * Check if the entire graph has any cycles
   */
  private checkGraphCycles(roles: Map<string, RoleNode>): void {
    for (const roleId of roles.keys()) {
      const cycle = this.detectCycle(roles, roleId);
      if (cycle) {
        throw new CycleDetectedError(cycle);
      }
    }
  }

  /**
   * Resolve effective permissions for a role
   */
  resolve(
    roles: RoleNode[] | Map<string, RoleNode>,
    roleId: string,
    options: ResolveOptions = {}
  ): ResolveResult {
    const { maxDepth = this.defaultMaxDepth, maxRoles = this.defaultMaxRoles } = options;

    // Convert to map if needed
    const roleMap =
      roles instanceof Map
        ? roles
        : new Map(roles.map((role) => [role.id, role]));

    // Validate roles
    if (roleMap.size > maxRoles) {
      throw new GraphSizeLimitExceededError(maxRoles);
    }
    this.validateRoles(roleMap);

    // Check for cycles in the entire graph
    this.checkGraphCycles(roleMap);

    // Check if target role exists
    if (!roleMap.has(roleId)) {
      throw new InvalidRoleError(roleId, "Role not found");
    }

    // Resolve permissions with cycle tracking
    const effectivePermissions = new Set<string>();
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    this.resolveRecursive(
      roleMap,
      roleId,
      effectivePermissions,
      visited,
      recursionStack,
      0,
      maxDepth
    );

    // Build inheritance path separately (DFS order)
    const inheritancePath = this.buildInheritancePath(roleMap, roleId, new Set());

    // Return deterministic ordering (sorted alphabetically)
    return {
      roleId,
      effectivePermissions: Array.from(effectivePermissions).sort(),
      inheritancePath,
    };
  }

  /**
   * Build inheritance path for a role (DFS order)
   */
  private buildInheritancePath(
    roles: Map<string, RoleNode>,
    roleId: string,
    visited: Set<string>
  ): string[] {
    if (visited.has(roleId)) {
      return [];
    }

    const role = roles.get(roleId);
    if (!role) {
      return [];
    }

    visited.add(roleId);
    const path: string[] = [roleId];

    for (const parentId of role.inherits) {
      const parentPath = this.buildInheritancePath(roles, parentId, visited);
      path.push(...parentPath);
    }

    return path;
  }

  /**
   * Recursive resolution with depth and cycle tracking
   */
  private resolveRecursive(
    roles: Map<string, RoleNode>,
    roleId: string,
    permissions: Set<string>,
    visited: Set<string>,
    recursionStack: Set<string>,
    currentDepth: number,
    maxDepth: number
  ): void {
    // Check depth limit
    if (currentDepth > maxDepth) {
      throw new DepthLimitExceededError(roleId, maxDepth);
    }

    // Check for cycles during resolution (node in current recursion path)
    if (recursionStack.has(roleId)) {
      const cycle = Array.from(recursionStack).concat([roleId]);
      throw new CycleDetectedError(cycle);
    }

    // Skip if already visited in a different branch (handles diamond inheritance)
    if (visited.has(roleId)) {
      return;
    }

    const role = roles.get(roleId);
    if (!role) {
      // This should have been caught by validation, but check anyway
      throw new MissingRoleError(roleId, roleId);
    }

    // Add to recursion stack and mark as visited
    recursionStack.add(roleId);
    visited.add(roleId);

    // Add direct permissions
    for (const permission of role.permissions) {
      permissions.add(permission);
    }

    // Resolve inherited permissions
    for (const parentId of role.inherits) {
      const parentRole = roles.get(parentId);
      if (!parentRole) {
        throw new MissingRoleError(roleId, parentId);
      }

      this.resolveRecursive(
        roles,
        parentId,
        permissions,
        visited,
        recursionStack,
        currentDepth + 1,
        maxDepth
      );
    }

    // Remove from recursion stack (backtrack)
    recursionStack.delete(roleId);
  }

  /**
   * Resolve effective permissions for multiple roles
   */
  resolveMultiple(
    roles: RoleNode[] | Map<string, RoleNode>,
    roleIds: string[],
    options: ResolveOptions = {}
  ): Map<string, ResolveResult> {
    const results = new Map<string, ResolveResult>();

    for (const roleId of roleIds) {
      try {
        const result = this.resolve(roles, roleId, options);
        results.set(roleId, result);
      } catch (error) {
        // Propagate errors - caller can handle partial failures
        throw error;
      }
    }

    return results;
  }
}
