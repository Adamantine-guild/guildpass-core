/**
 * Scoped permissions for community admin / integration operations (#145).
 * Checked via `requirePermission` instead of a single admin-or-not boolean.
 */
export const PERMISSIONS = [
  "read:access-decisions",
  "read:overrides",
  "write:overrides",
  "write:roles",
  "write:resources",
  "write:badges",
  "approve:governance-rules",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Named scope for read-only integrations (cannot mutate roles/overrides/resources). */
export const READ_ONLY_INTEGRATION_PERMISSIONS: readonly Permission[] = [
  "read:access-decisions",
  "read:overrides",
] as const;

type BuiltInRole = "admin" | "member" | "contributor";

/**
 * Default role → permission mappings. Preserves pre-#145 behaviour:
 * only `admin` can perform gated mutations; `contributor` / `member` get none.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<
  BuiltInRole,
  readonly Permission[]
> = {
  admin: [
    "read:access-decisions",
    "read:overrides",
    "write:overrides",
    "write:roles",
    "write:resources",
    "write:badges",
    "approve:governance-rules",
  ],
  contributor: [],
  member: [],
};
