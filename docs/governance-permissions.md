# Granular governance permissions

GuildPass policies can require named permissions in addition to the existing
`PUBLIC`, `MEMBERS_ONLY`, `ADMINS_ONLY`, and `CONTRIBUTORS_OR_ADMINS` rules.
Legacy rules and role hierarchy are unchanged.

## Model

A permission is a lowercase, colon-separated capability such as
`resource:create`, `resource:archive`, `member:remove`, or `policy:manage`.
Communities may introduce additional names following the same convention.

`RoleDefinition` remains community-scoped. Its `permissions` relation contains
the permissions granted by that custom role. A member receives those permissions
through an active, unexpired `RoleAssignment`. Permissions from parent custom
roles are inherited and duplicate grants are collapsed.

`AccessPolicy.requiredPermissions` is optional at the TypeScript boundary. When
present, every permission in the array is required. Permission checks are
conjunctive with the policy's rule:

```
legacy/composable rule passes AND all required permissions are granted
```

An explicit access override still has the highest precedence. Missing
permissions deny access. Invalid permission requirements fail closed; an empty
array is equivalent to omitting the field so Prisma's default is backward-safe.

## Admin API

Community administrators can manage roles with:

- `POST /v1/communities/:communityId/role-definitions`
- `GET /v1/communities/:communityId/role-definitions`
- `PUT /v1/communities/:communityId/role-definitions/:roleId`
- `DELETE /v1/communities/:communityId/role-definitions/:roleId`
- `PUT /v1/communities/:communityId/members/:wallet/custom-roles/:roleId`
- `DELETE /v1/communities/:communityId/members/:wallet/custom-roles/:roleId`

Create and update bodies use:

```json
{
  "name": "moderator",
  "description": "Moderates members without administering the community",
  "parentRoleId": null,
  "permissions": ["member:remove"]
}
```

The resource-policy endpoint accepts `requiredPermissions` alongside its
existing rule tree:

```json
{
  "ruleTree": { "type": "ACTIVE_MEMBERSHIP" },
  "requiredPermissions": ["resource:archive"]
}
```

## Migration guide

1. Apply `20260728_add_governance_permissions`. It adds `role_permissions` and
   a non-null `AccessPolicy.requiredPermissions` array whose database default is
   empty.
2. Deploy the API and policy engine.
3. Define community roles and assign them to members.
4. Add permission requirements to policies incrementally.

Existing policies require no data migration. An empty database array is mapped
to an omitted requirement before evaluation, so all four legacy rule types
produce the same decisions and reason codes as before.

When migrating an admin-only policy, keep `ADMINS_ONLY` while first validating
role assignments. Change the legacy rule only if the new custom role is
intended to replace, rather than supplement, administrator access.
