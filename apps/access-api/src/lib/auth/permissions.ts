import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type Role,
  VALID_ROLES,
} from "@guildpass/shared-types";

export class PermissionDeniedError extends Error {
  readonly statusCode = 403;
  readonly code = "FORBIDDEN" as const;

  constructor(message = "Not authorized") {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export type RoleLike = {
  role?: Role | string | null;
  active?: boolean;
};

/**
 * Authorization principal: wallet roles and/or explicit scopes
 * (e.g. a future ApiToken / integration identity).
 */
export type AuthzPrincipal = {
  roles?: RoleLike[] | null;
  /** Extra scopes unioned with role defaults (integration / API token). */
  grantedPermissions?: readonly Permission[] | null;
};

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (VALID_ROLES as readonly string[]).includes(value);
}

/** Resolve the effective permission set for a principal. */
export function resolvePermissions(principal: AuthzPrincipal): Set<Permission> {
  const granted = new Set<Permission>();

  for (const assignment of principal.roles ?? []) {
    if (assignment?.active === false) continue;
    if (!isRole(assignment?.role)) continue;
    for (const permission of DEFAULT_ROLE_PERMISSIONS[assignment.role]) {
      granted.add(permission);
    }
  }

  for (const permission of principal.grantedPermissions ?? []) {
    granted.add(permission);
  }

  return granted;
}

export function hasPermission(
  principal: AuthzPrincipal,
  permission: Permission,
): boolean {
  return resolvePermissions(principal).has(permission);
}

/**
 * Shared authorization gate used by memberService / resourceService (#145).
 * Throws {@link PermissionDeniedError} (403) when the principal lacks `permission`.
 */
export function requirePermission(
  principal: AuthzPrincipal,
  permission: Permission,
): void {
  if (!hasPermission(principal, permission)) {
    throw new PermissionDeniedError("Not authorized");
  }
}
