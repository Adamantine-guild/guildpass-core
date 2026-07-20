# API Versioning & Contract Stability Policy

This document defines the versioning strategy, stability guarantees, and deprecation lifecycle for the GuildPass Access API.

## Overview

The GuildPass API uses a **semver-style contract version** (`x-guildpass-api-version` header) to communicate backward-compatibility boundaries to consumers. The contract is defined by the JSON schemas published in `packages/shared-types/contracts/` and the TypeScript types in `packages/shared-types/src/`.

## Contract Version Format

The API version follows **Semantic Versioning 2.0**:

```
MAJOR.MINOR.PATCH
```

- **MAJOR** — Incompatible (breaking) changes to the public API contract.
- **MINOR** — Backward-compatible additions (new optional fields, new endpoints, new enum values).
- **PATCH** — Backward-compatible bug fixes or documentation corrections (no contract shape changes).

The version is emitted on every response as:

```
x-guildpass-api-version: 1.0.0
```

## What Counts as a Breaking Change

The following changes are **breaking** and require a MAJOR version bump:

| Change Type | Example |
|---|---|
| Removing a response field | Dropping `reasons` from `AccessDecision` |
| Changing a field's type | Changing `allowed` from `boolean` to `string` |
| Narrowing an enum | Removing `DENY` from the access code enum |
| Adding a required request field | Making `context` required on `POST /v1/access/check` |
| Removing an endpoint | Removing `GET /v1/communities/:id/members` |
| Removing a required response field | Dropping `allowed` from access check response |
| Changing HTTP method | Changing `POST /v1/access/check` to `GET` |
| Changing path structure | Changing `/v1/access/check` to `/v1/check` |
| Changing error envelope shape | Removing `statusCode` from `ErrorResponse` |

## What Counts as an Additive (Non-Breaking) Change

The following changes are **additive** and do NOT require a version bump:

| Change Type | Example |
|---|---|
| Adding an optional response field | Adding `debugInfo` to access check response |
| Adding a new endpoint | Adding `GET /v1/communities/:id/badges` |
| Adding a new enum value | Adding `"moderator"` to the Role enum |
| Adding an optional request field | Adding `context` (optional) to access check request |
| Deprecating a field | Marking `expiresAt` as deprecated (via header) |
| Removing a request field from schema | Consumers may still send it; servers ignore it |

## Deprecation Lifecycle

When a field or endpoint needs to be removed or changed incompatibly, it must go through the full deprecation lifecycle before removal:

### 1. Deprecation Notice (MINOR bump)

- Mark the field/endpoint as deprecated in the OpenAPI spec (`deprecated: true`)
- Add the `deprecation: true` response header on the affected route(s)
- Add a `Deprecation` header with the planned removal version
- Document the deprecation in the CHANGELOG
- Log warnings in the SDK when deprecated fields are encountered

### 2. Minimum Deprecation Window

Deprecated fields/endpoints must remain functional for **at least 6 months** (or **2 MINOR versions**, whichever is longer) before removal. This gives consumers time to migrate.

### 3. Removal (MAJOR bump)

- Remove the field/endpoint from the route schemas
- Update the contract snapshot in `packages/shared-types/contracts/`
- Bump the MAJOR version
- Document the removal in the CHANGELOG and migration guide

### Example Timeline

```
v1.0.0  — Field X is active
v1.1.0  — Field X is deprecated (header + docs)
v1.2.0  — Field X is still deprecated, warning logged
v2.0.0  — Field X is removed
```

## Public Contract Types

The following types are considered part of the **public API contract** and are protected by snapshot testing:

| Type | Endpoint | Role |
|---|---|---|
| `AccessDecision` | `POST /v1/access/check` (response) | Core access-control oracle |
| `AccessCheckInput` | `POST /v1/access/check` (request) | Input for access decisions |
| `RoleMutationResult` | `POST/DELETE /roles` (response) | Role assignment confirmation |
| `AccessOverrideMutationResult` | `POST/DELETE /overrides` (response) | Override mutation confirmation |
| `ApiErrorResponse` | All error responses | Standard error envelope |

Other response shapes (e.g., membership summaries, member profiles) are also part of the contract but are less likely to change since they serve read-only queries.

## Contract Snapshot Testing

Every PR is validated by an automated contract-compatibility test suite (`apps/access-api/test/apiContractCompatibility.test.ts`) that:

1. Loads the published versioned snapshot from `packages/shared-types/contracts/v1/schemas.json`
2. Extracts the current live contract from the Fastify route schemas in `apps/access-api/src/schemas.ts`
3. Diffs the two, classifying changes as **breaking** or **additive**
4. **Fails the build** if any breaking changes are detected without a corresponding version bump and new snapshot

### Updating the Snapshot

When you intentionally make a breaking change:

1. Update `packages/shared-types/contracts/v1/schemas.json` to reflect the new shapes
2. Bump the `version` field in the snapshot
3. Bump `x-guildpass-api-version` in `apps/access-api/src/app.ts`
4. Update `packages/shared-types/src/index.ts` types to match
5. Update `docs/openapi.json`
6. The compatibility test will then pass with the new snapshot

### Creating a New Version

When a new MAJOR version is released:

1. Create a new snapshot directory: `packages/shared-types/contracts/v2/`
2. Copy and update `schemas.json` with the new version's shapes
3. Keep the old snapshot for reference (it serves as documentation of v1)
4. Update `x-guildpass-api-version` to the new version
5. Update the test to compare against the latest snapshot

## Configuration

### SDK Version Checking

The SDK (`@guildpass/sdk-lite`) supports an `expectedApiVersion` option:

```typescript
const client = new GuildPassClient({
  baseUrl: 'https://api.guildpass.example.com',
  expectedApiVersion: '1.0.0', // Will warn on mismatch
});
```

When the server returns a different version than expected, the SDK logs a warning. This helps catch drift between SDK and server versions.

### Response Headers

Every API response includes:

```
x-guildpass-api-version: 1.0.0
x-correlation-id: <uuid>
```

Deprecated routes additionally include:

```
deprecation: true
```

## File Locations

| File | Purpose |
|---|---|
| `packages/shared-types/contracts/v1/schemas.json` | Published contract snapshot |
| `packages/shared-types/src/contractDiff.ts` | Diffing engine |
| `apps/access-api/test/apiContractCompatibility.test.ts` | Compatibility test suite |
| `apps/access-api/src/schemas.ts` | Live Fastify route schemas (source of truth) |
| `apps/access-api/src/app.ts` | API version header (`x-guildpass-api-version`) |
| `docs/openapi.json` | Machine-readable OpenAPI spec |
| `packages/shared-types/src/apiContract.ts` | TypeScript API contract constants |
