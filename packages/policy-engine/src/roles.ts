/**
 * Role Resolution Utilities
 * 
 * Handles role hierarchy and effective role calculation,
 * including custom role definitions and delegated grants!
 */

import type { RoleContext, Role, RoleDefinition, DelegatedGrant } from '@guildpass/shared-types';

/**
 * Options for resolving effective roles
 */
export interface ResolveEffectiveRolesOptions {
  roleDefinitions?: RoleDefinition[];
  delegatedGrants?: DelegatedGrant[];
}

/**
 * Recursively flattens a role definition hierarchy, with cycle detection!
 * @param roleDef - starting role definition
 * @param allRoleDefs - all role definitions available
 * @param visited - set of role def ids already visited (for cycle detection)
 * @returns array of role names, including built-in roles
 */
function flattenRoleHierarchy(
  roleDef: RoleDefinition,
  allRoleDefs: RoleDefinition[],
  visited: Set<string> = new Set()
): (Role | string)[] {
  if (visited.has(roleDef.id)) {
    // Cycle detected! Return empty to avoid infinite loop
    return [];
  }
  visited.add(roleDef.id);
  const roles: (Role | string)[] = [];

  // Add current role (either name or builtInRole)
  if (roleDef.builtInRole) {
    roles.push(roleDef.builtInRole);
  } else {
    roles.push(roleDef.name);
  }

  // Add parent roles if exists
  if (roleDef.parentRoleId) {
    const parentDef = allRoleDefs.find(def => def.id === roleDef.parentRoleId);
    if (parentDef) {
      const parentRoles = flattenRoleHierarchy(parentDef, allRoleDefs, visited);
      roles.push(...parentRoles);
    }
  }
  return roles;
}

/**
 * Resolves effective roles from a role context, including custom role hierarchies and delegated grants!
 * @param ctx - The role context containing assignments and membership state
 * @param options - Optional role definitions and delegated grants
 * @returns Array of effective roles
 */
export function resolveEffectiveRoles(
  ctx: RoleContext,
  options?: ResolveEffectiveRolesOptions
): (Role | string)[] {
  const roles: (Role | string)[] = [];
  const now = new Date();

  // Process role assignments
  for (const assignment of ctx.assignments) {
    // Skip inactive assignments
    if (!assignment.active) continue;
    // Skip expired assignments
    if (assignment.expiresAt) {
      const expiry = new Date(assignment.expiresAt);
      if (expiry < now) continue;
    }

    if (assignment.roleDefinitionId && options?.roleDefinitions) {
      // Process custom role definition
      const roleDef = options.roleDefinitions.find(def => def.id === assignment.roleDefinitionId);
      if (roleDef) {
        const hierarchyRoles = flattenRoleHierarchy(roleDef, options.roleDefinitions);
        roles.push(...hierarchyRoles);
      }
    } else if (assignment.role) {
      // Built-in role
      roles.push(assignment.role);
    }
  }

  // Add 'member' role if membership is active
  if (ctx.membershipState === 'active') {
    roles.push('member');
  }

  // Apply built-in role hierarchy (admin → contributor → member)
  const effective: (Role | string)[] = [...roles];
  if (roles.includes('admin')) {
    effective.push('contributor');
    effective.push('member');
  }
  if (roles.includes('contributor')) {
    effective.push('member');
  }

  // Apply delegated grants
  if (options?.delegatedGrants) {
    for (const grant of options.delegatedGrants) {
      // Skip revoked or expired grants
      if (grant.revokedAt) continue;
      if (grant.expiresAt && new Date(grant.expiresAt) < now) continue;
      // Add granted roles
      effective.push(...grant.roles);
    }
  }

  // Deduplicate and return
  return unique(effective);
}

/**
 * Utility to deduplicate an array
 */
function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
