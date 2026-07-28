import type {
  Permission,
  RoleContext,
  RoleDefinition,
} from '@guildpass/shared-types';

/**
 * Resolve permissions from active custom-role assignments. Parent-role
 * permissions are inherited because effective role resolution includes the
 * complete custom-role hierarchy.
 */
export function resolveEffectivePermissions(
  context: RoleContext,
  effectiveRoles: readonly string[],
  roleDefinitions: readonly RoleDefinition[] = [],
): Permission[] {
  const resolved = new Set<Permission>(context.permissions ?? []);

  for (const definition of roleDefinitions) {
    if (!effectiveRoles.includes(definition.name) && !(
      definition.builtInRole && effectiveRoles.includes(definition.builtInRole)
    )) {
      continue;
    }
    for (const permission of definition.permissions ?? []) {
      resolved.add(permission);
    }
  }

  return [...resolved].sort();
}

