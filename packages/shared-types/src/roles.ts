export const BUILT_IN_ROLES = [
  "admin",
  "member",
  "contributor"
] as const;

export type BuiltInRole =
  (typeof BUILT_IN_ROLES)[number];

export interface RoleDefinition {
  id: string;
  communityId: string;
  name: string;
  description?: string | null;
}
