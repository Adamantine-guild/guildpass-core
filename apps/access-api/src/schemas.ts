/**
 * schemas.ts
 *
 * Reusable JSON Schema fragments for all business routes registered in
 * routes.ts.  These are passed as the `schema` option to each Fastify route
 * registration so that @fastify/swagger can generate complete OpenAPI types
 * for every endpoint in /docs.
 *
 * Design rules:
 *  - One exported const per route, named after the route's purpose.
 *  - Every schema includes `response` for at least 200 and the primary error
 *    codes that route can return.
 *  - Shared fragments (errorSchema, walletParam, …) are defined once at the
 *    top and referenced inline — JSON Schema does not support $ref across
 *    separate const objects without a schema registry, so we spread/copy the
 *    relevant fragments.
 *  - Types are kept as narrow as possible (enum, pattern, etc.) so the
 *    generated OpenAPI spec gives consumers real type information.
 */

import { VALID_ROLES } from '@guildpass/shared-types';

// ---------------------------------------------------------------------------
// Shared primitive fragments
// ---------------------------------------------------------------------------

/** EVM wallet address: 0x followed by exactly 40 hex characters. */
const walletAddressSchema = {
  type: "string",
  pattern: "^0x[0-9a-fA-F]{40}$",
  description: "EVM-compatible wallet address (checksummed or lowercase)",
} as const;

/** Standard error envelope returned by every access-api error response. */
const errorSchema = {
  type: "object",
  required: ["error", "code", "message", "statusCode"],
  properties: {
    error: { type: "string", description: "Machine-readable error identifier" },
    code: { type: "string", description: "HTTP status phrase / error code" },
    message: { type: "string", description: "Human-readable description" },
    statusCode: { type: "integer", description: "HTTP status code" },
    details: {
      description: "Optional detail payload",
      oneOf: [{ type: "string" }, { type: "object" }],
    },
  },
} as const;

/** Minimal forbidden / auth error (routes that return a bare {error} object). */
const forbiddenSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string" },
  },
} as const;

/** Role enum values mirroring shared-types Role. */
const roleEnum = VALID_ROLES;

/** MembershipState enum values mirroring shared-types MembershipState. */
const membershipStateEnum = [
  "invited",
  "active",
  "expired",
  "suspended",
] as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/memberships/:wallet
// ---------------------------------------------------------------------------

export const getMembershipsSchema = {
  summary: "Get membership status summary for a wallet in a community",
  tags: ["Memberships"],
  params: {
    type: "object",
    required: ["communityId", "wallet"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
      wallet: walletAddressSchema,
    },
  },
  response: {
    200: {
      description: "Membership summary for the wallet",
      type: "object",
      properties: {
        wallet: walletAddressSchema,
        communities: {
          type: "array",
          items: {
            type: "object",
            required: ["communityId", "state"],
            properties: {
              communityId: { type: "string" },
              state: { type: "string", enum: membershipStateEnum },
              expiresAt: {
                type: "string",
                format: "date-time",
                nullable: true,
              },
            },
          },
        },
      },
      example: {
        wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        communities: [
          { communityId: "community-mainnet-42", state: "active", expiresAt: null },
          { communityId: "community-testnet-7", state: "expired", expiresAt: "2026-06-01T00:00:00.000Z" },
        ],
      },
    },
    404: {
      description: "Wallet not found",
      ...errorSchema,
      example: {
        error: "NOT_FOUND",
        code: "NOT_FOUND",
        message: "Wallet not found",
        statusCode: 404,
      },
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/members/:wallet
// ---------------------------------------------------------------------------

export const getMemberProfileSchema = {
  summary: "Get member profile with membership state and roles",
  tags: ["Members"],
  params: {
    type: "object",
    required: ["communityId", "wallet"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
      wallet: walletAddressSchema,
    },
  },
  response: {
    200: {
      description: "Member profile",
      type: "object",
      properties: {
        wallet: walletAddressSchema,
        communityId: { type: 'string' },
        profile: {
          type: "object",
          properties: {
            id: { type: "string" },
            displayName: { type: "string" },
            bio: { type: "string", nullable: true },
            avatarUrl: { type: "string", nullable: true },
          },
        },
        membership: {
          type: "object",
          properties: {
            state: { type: "string", enum: membershipStateEnum },
            expiresAt: { type: "string", format: "date-time", nullable: true },
          },
        },
        roles: {
          type: "array",
          items: { type: "string", enum: roleEnum },
        },
      },
      example: {
        wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        communityId: "community-mainnet-42",
        profile: {
          id: "mbr_01HZ9K3XB7E4F2WQMN8VDTG1R",
          displayName: "alice.eth",
          bio: "Core contributor",
          avatarUrl: null,
        },
        membership: { state: "active", expiresAt: null },
        roles: ["admin", "member"],
      },
    },
    400: {
      description: "Validation error",
      ...errorSchema,
      example: {
        error: "VALIDATION_ERROR",
        code: "VALIDATION_ERROR",
        message: "Invalid wallet format",
        statusCode: 400,
      },
    },
    404: {
      description: "Member not found",
      ...errorSchema,
      example: {
        error: "NOT_FOUND",
        code: "NOT_FOUND",
        message: "Member not found",
        statusCode: 404,
      },
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/communities/:communityId/members/:wallet/roles
// ---------------------------------------------------------------------------

export const assignMemberRoleSchema = {
  summary: "Assign a role to a community member",
  tags: ["Members", "Roles"],
  params: {
    type: "object",
    required: ["communityId", "wallet"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
      wallet: walletAddressSchema,
    },
  },
  body: {
    type: "object",
    required: ["role"],
    properties: {
      role: {
        type: "string",
        enum: roleEnum,
        description: "Role to assign",
        example: "contributor",
      },
    },
    example: { role: "contributor" },
  },
  response: {
    200: {
      description: "Role assigned successfully",
      type: "object",
      required: ["communityId", "wallet", "role", "assigned", "removed"],
      properties: {
        communityId: { type: "string" },
        wallet: walletAddressSchema,
        role: { type: "string", enum: roleEnum },
        assigned: { type: "boolean" },
        removed: { type: "boolean" },
        message: { type: "string" },
      },
      example: {
        communityId: "community-mainnet-42",
        wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        role: "contributor",
        assigned: true,
        removed: false,
        message: "Role contributor assigned to member",
      },
    },
    400: {
      description:
        "Validation error (invalid wallet, unknown community, or unrecognized role)",
      ...errorSchema,
      example: {
        error: "VALIDATION_ERROR",
        code: "INVALID_ROLE",
        message: "Unrecognized role",
        statusCode: 400,
      },
    },
    403: {
      description: "Forbidden — requester does not have permission",
      ...forbiddenSchema,
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// DELETE /v1/communities/:communityId/members/:wallet/roles/:role
// ---------------------------------------------------------------------------

export const removeMemberRoleSchema = {
  summary: "Remove a role from a community member",
  tags: ["Members", "Roles"],
  params: {
    type: "object",
    required: ["communityId", "wallet", "role"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
      wallet: walletAddressSchema,
      role: { type: "string", enum: roleEnum, description: "Role to remove", example: "contributor" },
    },
  },
  response: {
    200: {
      description: "Role removed successfully",
      type: "object",
      required: ["communityId", "wallet", "role", "assigned", "removed"],
      properties: {
        communityId: { type: "string" },
        wallet: walletAddressSchema,
        role: { type: "string", enum: roleEnum },
        assigned: { type: "boolean" },
        removed: { type: "boolean" },
        message: { type: "string" },
      },
      example: {
        communityId: "community-mainnet-42",
        wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        role: "contributor",
        assigned: false,
        removed: true,
        message: "Role contributor removed from member",
      },
    },
    400: {
      description:
        "Validation error (invalid wallet, unknown community, or unrecognized role)",
      ...errorSchema,
      example: {
        error: "VALIDATION_ERROR",
        code: "INVALID_WALLET",
        message: "Invalid wallet format",
        statusCode: 400,
      },
    },
    403: {
      description: "Forbidden — requester does not have permission",
      ...forbiddenSchema,
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/communities/:communityId/overrides
// ---------------------------------------------------------------------------

export const createAccessOverrideSchema = {
  summary: "Create or update an access override for a wallet/resource pair",
  tags: ["Overrides"],
  params: {
    type: "object",
    required: ["communityId"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
    },
  },
  body: {
    type: "object",
    required: ["wallet", "resource", "effect"],
    properties: {
      wallet: walletAddressSchema,
      resource: { type: "string", description: "Resource identifier", example: "channel:announcements" },
      effect: {
        type: "string",
        enum: ["ALLOW", "DENY"],
        description: "Override effect",
        example: "DENY",
      },
      reason: {
        type: "string",
        description: "Human-readable reason for the override",
        nullable: true,
        example: "Temporary ban pending investigation",
      },
      expiresAt: {
        type: "string",
        format: "date-time",
        description: "Optional ISO 8601 expiry timestamp",
        nullable: true,
        example: "2026-08-28T00:00:00.000Z",
      },
    },
    example: {
      wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      resource: "channel:announcements",
      effect: "DENY",
      reason: "Temporary ban pending investigation",
      expiresAt: "2026-08-28T00:00:00.000Z",
    },
  },
  response: {
    200: {
      description: "Override created or updated",
      type: "object",
      required: [
        "communityId",
        "wallet",
        "resource",
        "effect",
        "created",
        "removed",
      ],
      properties: {
        communityId: { type: "string" },
        wallet: walletAddressSchema,
        resource: { type: "string" },
        effect: { type: "string", enum: ["ALLOW", "DENY"] },
        created: { type: "boolean" },
        removed: { type: "boolean" },
        message: { type: "string" },
      },
      example: {
        communityId: "community-mainnet-42",
        wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        resource: "channel:announcements",
        effect: "DENY",
        created: true,
        removed: false,
        message: "Access override created",
      },
    },
    400: {
      description: "Validation error — missing required fields",
      ...errorSchema,
      example: {
        error: "VALIDATION_ERROR",
        code: "VALIDATION_ERROR",
        message: "Missing required fields: wallet, resource, effect",
        statusCode: 400,
      },
    },
    403: {
      description: "Forbidden — requester does not have permission",
      ...forbiddenSchema,
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/overrides
// ---------------------------------------------------------------------------

export const listAccessOverridesSchema = {
  summary: 'List access overrides for a community (admin)',
  tags: ['Overrides'],
  params: {
    type: 'object',
    required: ['communityId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
    },
  },
  response: {
    200: {
      description: 'Access overrides for the community',
      type: 'object',
      required: ['communityId', 'overrides'],
      properties: {
        communityId: { type: 'string' },
        overrides: {
          type: 'array',
          items: {
            type: 'object',
            required: ['wallet', 'resource', 'effect', 'expired', 'createdAt'],
            properties: {
              wallet: walletAddressSchema,
              resource: { type: 'string' },
              effect: { type: 'string', enum: ['ALLOW', 'DENY'] },
              reason: { type: 'string', nullable: true },
              expiresAt: { type: 'string', format: 'date-time', nullable: true },
              expired: {
                type: 'boolean',
                description: 'Whether expiresAt has passed; expired overrides no longer affect access decisions',
              },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
      example: {
        communityId: 'community-mainnet-42',
        overrides: [
          {
            wallet: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
            resource: 'channel:announcements',
            effect: 'DENY',
            reason: 'Temporary ban pending investigation',
            expiresAt: '2026-08-28T00:00:00.000Z',
            expired: false,
            createdAt: '2026-07-28T12:00:00.000Z',
          },
        ],
      },
    },
    403: {
      description: 'Forbidden — requester does not have permission',
      ...forbiddenSchema,
    },
    500: {
      description: 'Internal server error',
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// DELETE /v1/communities/:communityId/overrides/:wallet/:resource
// ---------------------------------------------------------------------------

export const revokeAccessOverrideSchema = {
  summary: "Revoke an access override for a wallet/resource pair",
  tags: ["Overrides"],
  params: {
    type: "object",
    required: ["communityId", "wallet", "resource"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
      wallet: walletAddressSchema,
      resource: { type: "string", description: "Resource identifier", example: "channel:announcements" },
    },
  },
  response: {
    200: {
      description: "Override revoked",
      type: "object",
      required: [
        "communityId",
        "wallet",
        "resource",
        "effect",
        "created",
        "removed",
      ],
      properties: {
        communityId: { type: "string" },
        wallet: walletAddressSchema,
        resource: { type: "string" },
        effect: { type: "string", enum: ["ALLOW", "DENY"] },
        created: { type: "boolean" },
        removed: { type: "boolean" },
        message: { type: "string" },
      },
      example: {
        communityId: "community-mainnet-42",
        wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        resource: "channel:announcements",
        effect: "DENY",
        created: false,
        removed: true,
        message: "Access override revoked",
      },
    },
    403: {
      description: "Forbidden — requester does not have permission",
      ...forbiddenSchema,
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Badge shared fragments
// ---------------------------------------------------------------------------

const badgeItemSchema = {
  type: "object",
  required: ["id", "memberId", "label", "issuedAt"],
  properties: {
    id: { type: "string" },
    memberId: { type: "string" },
    label: { type: "string" },
    issuedAt: { type: "string", format: "date-time" },
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/communities/:communityId/members/:wallet/badges
// ---------------------------------------------------------------------------

export const assignBadgeSchema = {
  summary: "Assign a badge to a community member",
  tags: ["Members", "Badges"],
  params: {
    type: "object",
    required: ["communityId", "wallet"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
      wallet: walletAddressSchema,
    },
  },
  body: {
    type: "object",
    required: ["label"],
    properties: {
      label: {
        type: "string",
        minLength: 1,
        description: "Badge label to assign",
        example: "early-contributor",
      },
    },
    example: { label: "early-contributor" },
  },
  response: {
    200: {
      description: "Badge assigned successfully",
      type: "object",
      required: ["communityId", "wallet", "assigned", "removed"],
      properties: {
        communityId: { type: "string" },
        wallet: walletAddressSchema,
        badge: badgeItemSchema,
        assigned: { type: "boolean" },
        removed: { type: "boolean" },
        message: { type: "string" },
      },
      example: {
        communityId: "community-mainnet-42",
        wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        badge: {
          id: "bdg_01HZ9K3XB7E4F2WQMN8VDTG1R",
          memberId: "mbr_01HZ9K3XB7E4F2WQMN8VDTG1R",
          label: "early-contributor",
          issuedAt: "2026-07-28T12:00:00.000Z",
        },
        assigned: true,
        removed: false,
        message: "Badge early-contributor assigned",
      },
    },
    400: {
      description:
        "Validation error (invalid wallet, unknown community, or missing label)",
      ...errorSchema,
      example: {
        error: "VALIDATION_ERROR",
        code: "VALIDATION_ERROR",
        message: "Missing required field: label",
        statusCode: 400,
      },
    },
    403: {
      description: "Forbidden — requester does not have permission",
      ...forbiddenSchema,
    },
    404: {
      description: "Target wallet is not a member of the community",
      ...errorSchema,
      example: {
        error: "NOT_FOUND",
        code: "NOT_FOUND",
        message: "Member not found",
        statusCode: 404,
      },
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/members/:wallet/badges
// ---------------------------------------------------------------------------

export const listBadgesSchema = {
  summary: "List badges assigned to a community member",
  tags: ["Members", "Badges"],
  params: {
    type: "object",
    required: ["communityId", "wallet"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
      wallet: walletAddressSchema,
    },
  },
  response: {
    200: {
      description: "Badges for the member",
      type: "object",
      required: ["communityId", "wallet", "badges"],
      properties: {
        communityId: { type: "string" },
        wallet: walletAddressSchema,
        badges: {
          type: "array",
          items: badgeItemSchema,
        },
      },
      example: {
        communityId: "community-mainnet-42",
        wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        badges: [
          {
            id: "bdg_01HZ9K3XB7E4F2WQMN8VDTG1R",
            memberId: "mbr_01HZ9K3XB7E4F2WQMN8VDTG1R",
            label: "early-contributor",
            issuedAt: "2026-07-28T12:00:00.000Z",
          },
        ],
      },
    },
    400: {
      description: "Validation error (invalid wallet or unknown community)",
      ...errorSchema,
      example: {
        error: "VALIDATION_ERROR",
        code: "UNKNOWN_COMMUNITY",
        message: "Unknown communityId",
        statusCode: 400,
      },
    },
    404: {
      description: "Target wallet is not a member of the community",
      ...errorSchema,
      example: {
        error: "NOT_FOUND",
        code: "NOT_FOUND",
        message: "Member not found",
        statusCode: 404,
      },
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// DELETE /v1/communities/:communityId/members/:wallet/badges/:badgeId
// ---------------------------------------------------------------------------

export const revokeBadgeSchema = {
  summary: "Revoke a badge from a community member",
  tags: ["Members", "Badges"],
  params: {
    type: "object",
    required: ["communityId", "wallet", "badgeId"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
      wallet: walletAddressSchema,
      badgeId: { type: "string", description: "Badge identifier", example: "bdg_01HZ9K3XB7E4F2WQMN8VDTG1R" },
    },
  },
  response: {
    200: {
      description: "Badge revoked (or was already absent)",
      type: "object",
      required: ["communityId", "wallet", "assigned", "removed"],
      properties: {
        communityId: { type: "string" },
        wallet: walletAddressSchema,
        assigned: { type: "boolean" },
        removed: { type: "boolean" },
        message: { type: "string" },
      },
      example: {
        communityId: "community-mainnet-42",
        wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        assigned: false,
        removed: true,
        message: "Badge revoked",
      },
    },
    400: {
      description: "Validation error (invalid wallet or unknown community)",
      ...errorSchema,
      example: {
        error: "VALIDATION_ERROR",
        code: "INVALID_WALLET",
        message: "Invalid wallet format",
        statusCode: 400,
      },
    },
    403: {
      description: "Forbidden — requester does not have permission",
      ...forbiddenSchema,
    },
    404: {
      description: "Target wallet is not a member of the community",
      ...errorSchema,
      example: {
        error: "NOT_FOUND",
        code: "NOT_FOUND",
        message: "Member not found",
        statusCode: 404,
      },
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/access/check
// ---------------------------------------------------------------------------
export interface AccessCheckBody {
  wallet: string;
  communityId: string;
  resource: string;
}

export const accessCheckSchema = {
  summary: "Check whether a wallet has access to a resource in a community",
  tags: ["Access"],
  body: {
    type: "object",
    required: ["wallet", "communityId", "resource"],
    additionalProperties: false,
    properties: {
      wallet: {
        type: "string",
        pattern: "^0x[0-9a-fA-F]{40}$",
        description: "EVM-compatible wallet address (checksummed or lowercase)",
        example: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      },
      communityId: {
        type: "string",
        minLength: 1,
        description: "Community identifier",
        example: "community-mainnet-42",
      },
      resource: {
        type: "string",
        minLength: 1,
        description: "Resource identifier",
        example: "channel:announcements",
      },
    },
    example: {
      wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      communityId: "community-mainnet-42",
      resource: "channel:announcements",
    },
  },
  response: {
    200: {
      description: "Access decision",
      type: "object",
      required: ["allowed", "code"],
      properties: {
        allowed: { type: "boolean" },
        code: { type: "string", enum: ["ALLOW", "DENY"] },
        reasons: {
          type: "array",
          items: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
          },
        },
        effectiveRoles: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
        membershipState: { type: "string", nullable: true },
      },
      example: {
        allowed: true,
        code: "ALLOW",
        reasons: [{ code: "ROLE_MATCH", message: "Wallet holds the 'member' role" }],
        effectiveRoles: ["admin", "member"],
        membershipState: "active",
      },
    },
    400: {
      description: "Validation error — missing required fields or invalid format",
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            details: {
              description: "Optional detail payload (validation array or message)",
              oneOf: [
                { type: "string" },
                { type: "object", additionalProperties: true },
                { type: "array", items: { type: "object", additionalProperties: true } },
              ],
            },
          },
        },
      },
      example: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid wallet address format",
        },
      },
    },
    429: {
      description:
        "Rate limit exceeded for this IP/API key or wallet. Clients must honour the Retry-After header (RFC 9110 delta-seconds) before retrying.",
      headers: {
        "Retry-After": {
          schema: { type: "integer", minimum: 1 },
          description:
            "Seconds until the client may retry (RFC 9110 delta-seconds, not milliseconds)",
        },
        "X-RateLimit-Reset": {
          schema: { type: "integer", minimum: 1 },
          description: "Same value as Retry-After, for clients that prefer this header name",
        },
      },
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "string", enum: ["RATE_LIMITED"] },
            message: { type: "string" },
            details: {
              description: "Includes retryAfter in seconds when present",
              oneOf: [
                { type: "string" },
                { type: "object", additionalProperties: true },
              ],
            },
          },
        },
      },
      example: {
        error: {
          code: "RATE_LIMITED",
          message: "Rate limit exceeded. Retry after 30 seconds.",
          details: { retryAfter: 30 },
        },
      },
    },
    500: {
      description: "Internal server error",
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            details: {
              oneOf: [
                { type: "string" },
                { type: "object", additionalProperties: true },
              ],
            },
          },
        },
      },
      example: {
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/members  (admin listing)
// ---------------------------------------------------------------------------

export const listCommunityMembersSchema = {
  summary: "List community members (admin)",
  tags: ["Members"],
  params: {
    type: "object",
    required: ["communityId"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
    },
  },
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      role: {
        type: "string",
        enum: roleEnum,
        description: "Filter members by role",
      },
      status: {
        type: "string",
        enum: membershipStateEnum,
        description: "Filter members by membership status",
      },
      page: {
        type: "integer",
        minimum: 1,
        default: 1,
        description: "1-based page number. Values below 1 return 400.",
      },
      pageSize: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 25,
        description:
          "Page size (default 25, maximum 100). Requests above 100 return 400.",
      },
      sort: {
        type: "string",
        enum: ["joinedAt", "role"],
        default: "joinedAt",
        description:
          "Sort field. A stable id ASC tiebreaker is always applied so pages never overlap.",
      },
    },
  },
  response: {
    200: {
      description: "Offset-paginated member list",
      type: "object",
      required: ["data", "total", "page", "pageSize", "nextCursor"],
      properties: {
        data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              wallet: walletAddressSchema,
              displayName: { type: "string", nullable: true },
              state: { type: "string", enum: membershipStateEnum },
              roles: {
                type: "array",
                items: { type: "string", enum: roleEnum },
              },
              joinedAt: { type: "string", format: "date-time" },
            },
          },
        },
        total: {
          type: "integer",
          description: "Total members matching the filters, across all pages",
        },
        page: { type: "integer" },
        pageSize: { type: "integer" },
        nextCursor: {
          type: "string",
          nullable: true,
          description:
            "Always null in offset mode; reserved for a future move to cursor pagination",
        },
      },
      example: {
        data: [
          {
            wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
            displayName: "alice.eth",
            state: "active",
            roles: ["admin", "member"],
            joinedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            wallet: "0xabcd1234567890abcd1234567890abcd12345678",
            displayName: null,
            state: "active",
            roles: ["member"],
            joinedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        total: 2,
        page: 1,
        pageSize: 25,
        nextCursor: null,
      },
    },
    400: {
      description: "Invalid query parameters (e.g. pageSize above 100)",
      ...errorSchema,
      example: {
        error: "VALIDATION_ERROR",
        code: "VALIDATION_ERROR",
        message: "Invalid query parameters",
        statusCode: 400,
      },
    },
    403: {
      description: "Forbidden — requester is not a community admin",
      ...forbiddenSchema,
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/dead-letter-events
// ---------------------------------------------------------------------------

/** Shared dead-letter event item shape. */
const deadLetterEventItemSchema = {
  type: "object",
  required: [
    "id",
    "originalEventId",
    "eventType",
    "failureReason",
    "retryCount",
    "status",
    "createdAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    originalEventId: { type: "string", format: "uuid" },
    eventType: { type: "string" },
    entityId: { type: "string", nullable: true },
    entityType: { type: "string", nullable: true },
    communityId: { type: "string", nullable: true },
    payload: { type: "object", additionalProperties: true },
    failureReason: { type: "string" },
    retryCount: { type: "integer", minimum: 0 },
    status: { type: "string", enum: ["pending", "retried", "resolved"] },
    createdAt: { type: "string", format: "date-time" },
    resolvedAt: { type: "string", format: "date-time", nullable: true },
  },
} as const;

export const listDeadLetterEventsSchema = {
  summary: "List dead-lettered webhook delivery events for a community",
  tags: ["Dead Letter"],
  params: {
    type: "object",
    required: ["communityId"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
    },
  },
  querystring: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending", "retried", "resolved"],
        description: "Filter events by status",
      },
    },
  },
  response: {
    200: {
      description: "List of dead-letter events",
      type: "object",
      required: ["events"],
      properties: {
        events: {
          type: "array",
          items: deadLetterEventItemSchema,
        },
      },
      example: {
        events: [
          {
            id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            originalEventId: "f0e1d2c3-b4a5-6789-0fed-cba987654321",
            eventType: "membership.updated",
            entityId: "mbr_01HZ9K3XB7E4F2WQMN8VDTG1R",
            entityType: "membership",
            communityId: "community-mainnet-42",
            payload: { state: "suspended" },
            failureReason: "Webhook endpoint returned 503",
            retryCount: 3,
            status: "pending",
            createdAt: "2026-07-28T12:00:00.000Z",
            resolvedAt: null,
          },
        ],
      },
    },
    403: {
      description: "Forbidden — requester is not a community admin",
      ...forbiddenSchema,
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/communities/:communityId/dead-letter-events/:id/retry
// ---------------------------------------------------------------------------

export const retryDeadLetterEventSchema = {
  summary: "Re-enqueue a dead-lettered event for redelivery",
  tags: ["Dead Letter"],
  params: {
    type: "object",
    required: ["communityId", "id"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
      id: {
        type: "string",
        format: "uuid",
        description: "Dead-letter event ID",
        example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      },
    },
  },
  response: {
    200: {
      description: "Event re-enqueued successfully",
      type: "object",
      required: ["newEventId"],
      properties: {
        newEventId: {
          type: "string",
          format: "uuid",
          description: "ID of the newly created pending outbox event",
        },
      },
      example: { newEventId: "b2c3d4e5-f6a7-8901-bcde-f12345678901" },
    },
    403: {
      description: "Forbidden — requester is not a community admin",
      ...forbiddenSchema,
    },
    404: {
      description: "Dead-letter event not found",
      ...errorSchema,
      example: {
        error: "NOT_FOUND",
        code: "NOT_FOUND",
        message: "Dead-letter event not found",
        statusCode: 404,
      },
    },
    409: {
      description: "Event has already been retried or resolved",
      ...forbiddenSchema,
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/audit-events
// ---------------------------------------------------------------------------

export const listAuditEventsSchema = {
  summary: "List and filter audit events for a community (admin only)",
  tags: ["Audit"],
  params: {
    type: "object",
    required: ["communityId"],
    properties: {
      communityId: { type: "string", description: "Community identifier", example: "community-mainnet-42" },
    },
  },
  querystring: {
    type: "object",
    properties: {
      actorWallet: {
        type: "string",
        description: "Filter events by actor wallet address",
        example: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      },
      eventType: {
        type: "string",
        enum: [
          "ACCESS_CHECK",
          "MEMBERSHIP_CREATED",
          "MEMBERSHIP_UPDATED",
          "MEMBERSHIP_DELETED",
          "POLICY_EVALUATION",
          "MEMBERSHIP_RECONCILED",
          "OTHER",
        ],
        description: "Filter events by event type",
      },
      resource: {
        type: "string",
        description: "Filter events by resource identifier",
        example: "channel:announcements",
      },
      from: {
        type: "string",
        format: "date-time",
        description: "ISO 8601 timestamp to filter events created at or after",
        example: "2026-07-01T00:00:00.000Z",
      },
      to: {
        type: "string",
        format: "date-time",
        description: "ISO 8601 timestamp to filter events created at or before",
        example: "2026-07-31T23:59:59.000Z",
      },
      page: {
        type: "integer",
        minimum: 1,
        default: 1,
        description: "Page number for pagination",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 20,
        description: "Number of events per page",
      },
    },
  },
  response: {
    200: {
      description: "Paginated audit events list",
      type: "object",
      required: ["events", "pagination"],
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "eventType", "createdAt"],
            properties: {
              id: { type: "string", format: "uuid" },
              eventType: { type: "string" },
              walletId: { type: "string", nullable: true },
              communityId: { type: "string", nullable: true },
              resource: { type: "string", nullable: true },
              policyRule: { type: "string", nullable: true },
              decision: { type: "string", nullable: true },
              reasonCode: { type: "string", nullable: true },
              beforeState: { type: "object", additionalProperties: true, nullable: true },
              afterState: { type: "object", additionalProperties: true, nullable: true },
              correlationId: { type: "string", nullable: true },
              chainId: { type: "integer", nullable: true },
              txHash: { type: "string", nullable: true },
              blockNumber: { type: "integer", nullable: true },
              logIndex: { type: "integer", nullable: true },
              membershipStateVersion: { type: "string", nullable: true },
              roleStateVersion: { type: "string", nullable: true },
              recordHash: { type: "string", nullable: true },
              previousRecordHash: { type: "string", nullable: true },
              createdAt: { type: "string", format: "date-time" },
            },
          },
        },
        pagination: {
          type: "object",
          required: ["page", "limit", "total", "totalPages"],
          properties: {
            page: { type: "integer" },
            limit: { type: "integer" },
            total: { type: "integer" },
            totalPages: { type: "integer" },
          },
        },
      },
      example: {
        events: [
          {
            id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            eventType: "ACCESS_CHECK",
            walletId: "wlt_01HZ9K3XB7E4F2WQMN8VDTG1R",
            communityId: "community-mainnet-42",
            resource: "channel:announcements",
            policyRule: "ROLE_MATCH",
            decision: "ALLOW",
            reasonCode: "ACTIVE_MEMBER",
            beforeState: null,
            afterState: null,
            correlationId: "req-abc123",
            chainId: 1,
            txHash: null,
            blockNumber: null,
            logIndex: null,
            membershipStateVersion: "v1",
            roleStateVersion: "v2",
            recordHash: "sha256:abc123",
            previousRecordHash: null,
            createdAt: "2026-07-28T12:00:00.000Z",
          },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      },
    },
    400: {
      description: "Validation error (e.g. invalid date format)",
      ...errorSchema,
      example: {
        error: "VALIDATION_ERROR",
        code: "VALIDATION_ERROR",
        message: "Invalid from date format",
        statusCode: 400,
      },
    },
    403: {
      description: "Forbidden — requester is not a community admin",
      ...forbiddenSchema,
    },
    500: {
      description: "Internal server error",
      ...forbiddenSchema,
    },
  },
} as const;

const ruleAstSchema = {
  type: 'object',
  additionalProperties: true,
} as const;

/** Shared governance rule shape returned by the CRUD routes. */
const governanceRuleObjectSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    communityId: { type: 'string' },
    resource: { type: 'string' },
    active: { type: 'boolean' },
    ast: ruleAstSchema,
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/communities/:communityId/governance-rules
// ---------------------------------------------------------------------------

export const createGovernanceRuleSchema = {
  summary: 'Create a governance rule for a community resource',
  tags: ['Governance'],
  params: {
    type: 'object',
    required: ['communityId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
    },
  },
  body: {
    type: 'object',
    required: ['name', 'description', 'resource', 'ast'],
    properties: {
      name: { type: 'string', description: 'Unique rule name within the resource', example: 'require-active-membership' },
      description: { type: 'string', description: 'Human-readable description', example: 'Grants access only to wallets with active membership' },
      resource: { type: 'string', description: 'Resource the rule governs', example: 'channel:announcements' },
      ast: ruleAstSchema,
    },
    example: {
      name: 'require-active-membership',
      description: 'Grants access only to wallets with active membership',
      resource: 'channel:announcements',
      ast: { type: 'MEMBERSHIP_STATE', states: ['active'] },
    },
  },
  response: {
    201: {
      ...governanceRuleObjectSchema,
      description: 'Rule created',
      example: {
        id: 'rule_01HZ9K3XB7E4F2WQMN8VDTG1R',
        name: 'require-active-membership',
        description: 'Grants access only to wallets with active membership',
        communityId: 'community-mainnet-42',
        resource: 'channel:announcements',
        active: true,
        ast: { type: 'MEMBERSHIP_STATE', states: ['active'] },
      },
    },
    400: {
      description: 'Validation error (missing fields or invalid AST)',
      ...errorSchema,
      example: {
        error: 'VALIDATION_ERROR',
        code: 'VALIDATION_ERROR',
        message: 'Missing required field: ast',
        statusCode: 400,
      },
    },
    403: { description: 'Forbidden — requester is not a community admin', ...forbiddenSchema },
    409: {
      description: 'Duplicate rule name for the resource',
      ...errorSchema,
      example: {
        error: 'CONFLICT',
        code: 'CONFLICT',
        message: 'A rule named require-active-membership already exists for channel:announcements',
        statusCode: 409,
      },
    },
    500: { description: 'Internal server error', ...errorSchema },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/governance-rules
// ---------------------------------------------------------------------------

export const listGovernanceRulesSchema = {
  summary: 'List governance rules for a community',
  tags: ['Governance'],
  params: {
    type: 'object',
    required: ['communityId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      resource: { type: 'string', description: 'Filter by resource', example: 'channel:announcements' },
      activeOnly: {
        type: 'string',
        enum: ['true', 'false'],
        description: 'When "false", include inactive rules (default true)',
      },
    },
  },
  response: {
    200: {
      description: 'List of governance rules',
      type: 'object',
      required: ['rules'],
      properties: {
        rules: { type: 'array', items: governanceRuleObjectSchema },
      },
      example: {
        rules: [
          {
            id: 'rule_01HZ9K3XB7E4F2WQMN8VDTG1R',
            name: 'require-active-membership',
            description: 'Grants access only to wallets with active membership',
            communityId: 'community-mainnet-42',
            resource: 'channel:announcements',
            active: true,
            ast: { type: 'MEMBERSHIP_STATE', states: ['active'] },
          },
        ],
      },
    },
    403: { description: 'Forbidden — requester is not a community admin', ...forbiddenSchema },
    500: { description: 'Internal server error', ...errorSchema },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/governance-rules/:ruleId
// ---------------------------------------------------------------------------

export const getGovernanceRuleSchema = {
  summary: 'Get a single governance rule',
  tags: ['Governance'],
  params: {
    type: 'object',
    required: ['communityId', 'ruleId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
      ruleId: { type: 'string', description: 'Governance rule identifier', example: 'rule_01HZ9K3XB7E4F2WQMN8VDTG1R' },
    },
  },
  response: {
    200: {
      ...governanceRuleObjectSchema,
      description: 'The governance rule',
      example: {
        id: 'rule_01HZ9K3XB7E4F2WQMN8VDTG1R',
        name: 'require-active-membership',
        description: 'Grants access only to wallets with active membership',
        communityId: 'community-mainnet-42',
        resource: 'channel:announcements',
        active: true,
        ast: { type: 'MEMBERSHIP_STATE', states: ['active'] },
      },
    },
    403: { description: 'Forbidden — requester is not a community admin', ...forbiddenSchema },
    404: {
      description: 'Rule not found',
      ...errorSchema,
      example: {
        error: 'NOT_FOUND',
        code: 'NOT_FOUND',
        message: 'Governance rule not found',
        statusCode: 404,
      },
    },
    500: { description: 'Internal server error', ...errorSchema },
  },
} as const;

// ---------------------------------------------------------------------------
// PATCH /v1/communities/:communityId/governance-rules/:ruleId
// ---------------------------------------------------------------------------

export const updateGovernanceRuleSchema = {
  summary: 'Update a governance rule (partial)',
  tags: ['Governance'],
  params: {
    type: 'object',
    required: ['communityId', 'ruleId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
      ruleId: { type: 'string', description: 'Governance rule identifier', example: 'rule_01HZ9K3XB7E4F2WQMN8VDTG1R' },
    },
  },
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', example: 'require-active-or-contributor' },
      description: { type: 'string', example: 'Grants access to active members and contributors' },
      ast: ruleAstSchema,
      active: { type: 'boolean', description: 'Activate/deactivate the rule', example: true },
    },
    example: {
      description: 'Grants access to active members and contributors',
      active: true,
    },
  },
  response: {
    200: {
      ...governanceRuleObjectSchema,
      description: 'Updated rule',
      example: {
        id: 'rule_01HZ9K3XB7E4F2WQMN8VDTG1R',
        name: 'require-active-membership',
        description: 'Grants access to active members and contributors',
        communityId: 'community-mainnet-42',
        resource: 'channel:announcements',
        active: true,
        ast: { type: 'MEMBERSHIP_STATE', states: ['active'] },
      },
    },
    400: { description: 'Validation error (invalid AST)', ...errorSchema,
      example: { error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'Invalid AST structure', statusCode: 400 },
    },
    403: { description: 'Forbidden — requester is not a community admin', ...forbiddenSchema },
    404: { description: 'Rule not found', ...errorSchema,
      example: { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Governance rule not found', statusCode: 404 },
    },
    500: { description: 'Internal server error', ...errorSchema },
  },
} as const;

// ---------------------------------------------------------------------------
// DELETE /v1/communities/:communityId/governance-rules/:ruleId
// ---------------------------------------------------------------------------

export const deleteGovernanceRuleSchema = {
  summary: 'Delete a governance rule',
  tags: ['Governance'],
  params: {
    type: 'object',
    required: ['communityId', 'ruleId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
      ruleId: { type: 'string', description: 'Governance rule identifier' },
    },
  },
  response: {
    204: { description: 'Rule deleted', type: 'null' },
    403: { description: 'Forbidden — requester is not a community admin', ...forbiddenSchema },
    404: { description: 'Rule not found', ...errorSchema },
    500: { description: 'Internal server error', ...errorSchema },
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/communities/:communityId/governance-rules/:ruleId/approval-requests
// ---------------------------------------------------------------------------

export const createApprovalRequestSchema = {
  summary: 'Open an approval request for a governance rule',
  tags: ['Governance'],
  params: {
    type: 'object',
    required: ['communityId', 'ruleId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
      ruleId: { type: 'string', description: 'Governance rule identifier', example: 'rule_01HZ9K3XB7E4F2WQMN8VDTG1R' },
    },
  },
  body: {
    type: 'object',
    properties: {
      expiresAt: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description: 'Optional ISO 8601 expiry for the request',
        example: '2026-08-04T12:00:00.000Z',
      },
    },
    example: { expiresAt: '2026-08-04T12:00:00.000Z' },
  },
  response: {
    201: {
      description: 'Approval request created',
      type: 'object',
      additionalProperties: true,
      example: {
        id: 'apr_01HZ9K3XB7E4F2WQMN8VDTG1R',
        ruleId: 'rule_01HZ9K3XB7E4F2WQMN8VDTG1R',
        communityId: 'community-mainnet-42',
        requester: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
        status: 'open',
        expiresAt: '2026-08-04T12:00:00.000Z',
        createdAt: '2026-07-28T12:00:00.000Z',
      },
    },
    400: {
      description: 'Missing requester wallet',
      ...errorSchema,
      example: { error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'Missing requester wallet', statusCode: 400 },
    },
    404: {
      description: 'Rule not found',
      ...errorSchema,
      example: { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Governance rule not found', statusCode: 404 },
    },
    500: { description: 'Internal server error', ...errorSchema },
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/communities/:communityId/approval-requests/:requestId/approvals
// ---------------------------------------------------------------------------

export const submitApprovalSchema = {
  summary: 'Submit an approval or rejection for an approval request',
  tags: ['Governance'],
  params: {
    type: 'object',
    required: ['communityId', 'requestId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
      requestId: { type: 'string', description: 'Approval request identifier', example: 'apr_01HZ9K3XB7E4F2WQMN8VDTG1R' },
    },
  },
  body: {
    type: 'object',
    required: ['approverRole', 'approved'],
    properties: {
      approverRole: {
        type: 'string',
        enum: ['admin', 'member', 'contributor'],
        description: 'Role the approver is acting as',
        example: 'admin',
      },
      approved: { type: 'boolean', description: 'true to approve, false to reject', example: true },
      signature: { type: 'string', description: 'Optional cryptographic signature', example: '0x...' },
    },
    example: { approverRole: 'admin', approved: true },
  },
  response: {
    201: {
      description: 'Approval recorded',
      type: 'object',
      additionalProperties: true,
      example: {
        id: 'apv_01HZ9K3XB7E4F2WQMN8VDTG1R',
        requestId: 'apr_01HZ9K3XB7E4F2WQMN8VDTG1R',
        approverWallet: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
        approverRole: 'admin',
        approved: true,
        createdAt: '2026-07-28T12:05:00.000Z',
      },
    },
    400: {
      description: 'Validation error',
      ...errorSchema,
      example: { error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'approverRole is required', statusCode: 400 },
    },
    409: {
      description: 'Approver already submitted for this request',
      ...errorSchema,
      example: { error: 'CONFLICT', code: 'CONFLICT', message: 'Approver already submitted for this request', statusCode: 409 },
    },
    500: { description: 'Internal server error', ...errorSchema },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/approval-requests/:requestId/approvals
// ---------------------------------------------------------------------------

export const listApprovalsSchema = {
  summary: 'List approvals submitted for an approval request',
  tags: ['Governance'],
  params: {
    type: 'object',
    required: ['communityId', 'requestId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
      requestId: { type: 'string', description: 'Approval request identifier', example: 'apr_01HZ9K3XB7E4F2WQMN8VDTG1R' },
    },
  },
  response: {
    200: {
      description: 'List of approvals',
      type: 'object',
      required: ['approvals'],
      properties: {
        approvals: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      example: {
        approvals: [
          {
            id: 'apv_01HZ9K3XB7E4F2WQMN8VDTG1R',
            requestId: 'apr_01HZ9K3XB7E4F2WQMN8VDTG1R',
            approverWallet: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
            approverRole: 'admin',
            approved: true,
            createdAt: '2026-07-28T12:05:00.000Z',
          },
        ],
      },
    },
    500: { description: 'Internal server error', ...errorSchema },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/roles
// ---------------------------------------------------------------------------

export const getCommunityRolesSchema = {
  summary: 'Get community roles and hierarchy metadata',
  tags: ['Communities', 'Roles'],
  params: {
    type: 'object',
    required: ['communityId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
    },
  },
  response: {
    200: {
      description: 'List of community roles and hierarchy metadata',
      type: 'object',
      required: ['roles'],
      properties: {
        roles: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'description', 'implies'],
            properties: {
              name: { type: 'string', enum: roleEnum },
              description: { type: 'string' },
              implies: {
                type: 'array',
                items: { type: 'string', enum: roleEnum },
              },
            },
          },
        },
      },
      example: {
        roles: [
          { name: 'admin', description: 'Administrator with full permissions', implies: ['contributor', 'member'] },
          { name: 'contributor', description: 'Contributor with write permissions', implies: ['member'] },
          { name: 'member', description: 'Standard member with basic permissions', implies: [] },
        ],
      },
    },
    404: {
      description: 'Community not found',
      ...errorSchema,
      example: { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Community not found', statusCode: 404 },
    },
    500: { description: 'Internal server error', ...errorSchema },
  },
} as const;

// ---------------------------------------------------------------------------
// PUT /v1/communities/:communityId/resources/:resource/policy
// ---------------------------------------------------------------------------

export const updateCustomPolicySchema = {
  summary: 'Create or update a custom rule tree policy for a resource in a community',
  tags: ['Policies', 'Governance'],
  params: {
    type: 'object',
    required: ['communityId', 'resource'],
    properties: {
      communityId: { type: 'string', description: 'Community ID', example: 'community-mainnet-42' },
      resource: { type: 'string', description: 'Resource identifier', example: 'channel:announcements' },
    },
  },
  body: {
    type: 'object',
    required: ['ruleTree'],
    properties: {
      ruleTree: {
        type: 'object',
        description: 'Versioned, serializable rule tree AST',
        additionalProperties: true,
        example: { type: 'AND', children: [{ type: 'MEMBERSHIP_STATE', states: ['active'] }, { type: 'ROLE', role: 'member' }] },
      },
      requiredPermissions: {
        type: 'array',
        uniqueItems: true,
        description: 'Granular permissions required in addition to the rule tree',
        items: {
          type: 'string',
          pattern: '^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)+$',
        },
        example: ['content:read'],
      },
    },
    example: {
      ruleTree: { type: 'AND', children: [{ type: 'MEMBERSHIP_STATE', states: ['active'] }, { type: 'ROLE', role: 'member' }] },
      requiredPermissions: ['content:read'],
    },
  },
  response: {
    200: {
      description: 'Custom rule tree policy successfully saved',
      type: 'object',
      required: ['success', 'policy'],
      properties: {
        success: { type: 'boolean' },
        policy: {
          type: 'object',
          required: ['id', 'communityId', 'resource', 'ruleType'],
          properties: {
            id: { type: 'string' },
            communityId: { type: 'string' },
            resource: { type: 'string' },
            ruleType: { type: 'string' },
            params: { type: 'object', additionalProperties: true, nullable: true },
            requiredPermissions: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      example: {
        success: true,
        policy: {
          id: 'pol_01HZ9K3XB7E4F2WQMN8VDTG1R',
          communityId: 'community-mainnet-42',
          resource: 'channel:announcements',
          ruleType: 'COMPOSABLE',
          params: { ruleTree: { type: 'AND', children: [{ type: 'MEMBERSHIP_STATE', states: ['active'] }] } },
          requiredPermissions: ['content:read'],
        },
      },
    },
    400: {
      description: 'Malformed or oversized rule tree validation error',
      ...errorSchema,
      example: { error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'Invalid rule tree AST', statusCode: 400 },
    },
    401: { description: 'Unauthorized', ...errorSchema,
      example: { error: 'UNAUTHORIZED', code: 'UNAUTHORIZED', message: 'Missing or invalid API key', statusCode: 401 },
    },
    403: { description: 'Forbidden', ...errorSchema,
      example: { error: 'FORBIDDEN', code: 'FORBIDDEN', message: 'Requester is not a community admin', statusCode: 403 },
    },
    500: { description: 'Internal server error', ...errorSchema },
  },
} as const;

// ---------------------------------------------------------------------------
// Resource management shared fragments
// ---------------------------------------------------------------------------

const resourceItemSchema = {
  type: 'object',
  required: ['resourceId', 'name', 'metadata', 'archived'],
  properties: {
    resourceId: { type: 'string' },
    name: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true, nullable: true },
    archived: { type: 'boolean' },
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/communities/:communityId/resources
// ---------------------------------------------------------------------------

export const createResourceSchema = {
  summary: 'Create a new resource in a community',
  tags: ['Resources'],
  params: {
    type: 'object',
    required: ['communityId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
    },
  },
  body: {
    type: 'object',
    required: ['resourceId', 'name'],
    properties: {
      resourceId: { type: 'string', description: 'Resource identifier', example: 'channel:announcements' },
      name: { type: 'string', description: 'Human-readable name', example: 'Announcements Channel' },
      metadata: { type: 'object', additionalProperties: true, nullable: true, example: { discordChannelId: '123456789' } },
    },
    example: {
      resourceId: 'channel:announcements',
      name: 'Announcements Channel',
      metadata: { discordChannelId: '123456789' },
    },
  },
  response: {
    200: {
      description: 'Resource created or restored',
      type: 'object',
      required: ['communityId', 'resourceId', 'name', 'archived', 'created'],
      properties: {
        communityId: { type: 'string' },
        resourceId: { type: 'string' },
        name: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true, nullable: true },
        archived: { type: 'boolean' },
        created: { type: 'boolean' },
      },
      example: {
        communityId: 'community-mainnet-42',
        resourceId: 'channel:announcements',
        name: 'Announcements Channel',
        metadata: { discordChannelId: '123456789' },
        archived: false,
        created: true,
      },
    },
    400: { description: 'Validation error', ...errorSchema,
      example: { error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'Missing required field: name', statusCode: 400 },
    },
    401: { description: 'Unauthorized', ...errorSchema,
      example: { error: 'UNAUTHORIZED', code: 'UNAUTHORIZED', message: 'Missing or invalid API key', statusCode: 401 },
    },
    403: { description: 'Forbidden — requester does not have permission', ...errorSchema,
      example: { error: 'FORBIDDEN', code: 'FORBIDDEN', message: 'Requester is not a community admin', statusCode: 403 },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// PATCH /v1/communities/:communityId/resources/:resourceId
// ---------------------------------------------------------------------------

export const updateResourceSchema = {
  summary: 'Update an existing resource',
  tags: ['Resources'],
  params: {
    type: 'object',
    required: ['communityId', 'resourceId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
      resourceId: { type: 'string', description: 'Resource identifier', example: 'channel:announcements' },
    },
  },
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'New human-readable name', example: 'Official Announcements' },
      metadata: { type: 'object', additionalProperties: true, nullable: true },
    },
    example: { name: 'Official Announcements' },
  },
  response: {
    200: {
      description: 'Resource updated',
      type: 'object',
      required: ['communityId', 'resourceId', 'name', 'archived'],
      properties: {
        communityId: { type: 'string' },
        resourceId: { type: 'string' },
        name: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true, nullable: true },
        archived: { type: 'boolean' },
      },
      example: {
        communityId: 'community-mainnet-42',
        resourceId: 'channel:announcements',
        name: 'Official Announcements',
        metadata: { discordChannelId: '123456789' },
        archived: false,
      },
    },
    400: { description: 'Validation error', ...errorSchema,
      example: { error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'Nothing to update', statusCode: 400 },
    },
    401: { description: 'Unauthorized', ...errorSchema,
      example: { error: 'UNAUTHORIZED', code: 'UNAUTHORIZED', message: 'Missing or invalid API key', statusCode: 401 },
    },
    403: { description: 'Forbidden', ...errorSchema,
      example: { error: 'FORBIDDEN', code: 'FORBIDDEN', message: 'Requester is not a community admin', statusCode: 403 },
    },
    404: { description: 'Resource not found', ...errorSchema,
      example: { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Resource not found', statusCode: 404 },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// DELETE /v1/communities/:communityId/resources/:resourceId
// ---------------------------------------------------------------------------

export const archiveResourceSchema = {
  summary: 'Archive a resource',
  tags: ['Resources'],
  params: {
    type: 'object',
    required: ['communityId', 'resourceId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
      resourceId: { type: 'string', description: 'Resource identifier', example: 'channel:announcements' },
    },
  },
  response: {
    200: {
      description: 'Resource archived',
      type: 'object',
      required: ['communityId', 'resourceId', 'archived'],
      properties: {
        communityId: { type: 'string' },
        resourceId: { type: 'string' },
        archived: { type: 'boolean' },
      },
      example: {
        communityId: 'community-mainnet-42',
        resourceId: 'channel:announcements',
        archived: true,
      },
    },
    400: { description: 'Validation error', ...errorSchema,
      example: { error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'Invalid resourceId', statusCode: 400 },
    },
    401: { description: 'Unauthorized', ...errorSchema,
      example: { error: 'UNAUTHORIZED', code: 'UNAUTHORIZED', message: 'Missing or invalid API key', statusCode: 401 },
    },
    403: { description: 'Forbidden', ...errorSchema,
      example: { error: 'FORBIDDEN', code: 'FORBIDDEN', message: 'Requester is not a community admin', statusCode: 403 },
    },
    404: { description: 'Resource not found', ...errorSchema,
      example: { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Resource not found', statusCode: 404 },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/resources
// ---------------------------------------------------------------------------

export const listResourcesSchema = {
  summary: 'List resources for a community',
  tags: ['Resources'],
  params: {
    type: 'object',
    required: ['communityId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
    },
  },
  response: {
    200: {
      description: 'List of resources',
      type: 'object',
      required: ['communityId', 'resources'],
      properties: {
        communityId: { type: 'string' },
        resources: {
          type: 'array',
          items: resourceItemSchema,
        },
      },
      example: {
        communityId: 'community-mainnet-42',
        resources: [
          { resourceId: 'channel:announcements', name: 'Announcements Channel', metadata: { discordChannelId: '123456789' }, archived: false },
          { resourceId: 'channel:general', name: 'General Chat', metadata: null, archived: false },
        ],
      },
    },
    400: { description: 'Validation error', ...errorSchema,
      example: { error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'Invalid communityId', statusCode: 400 },
    },
    401: { description: 'Unauthorized', ...errorSchema,
      example: { error: 'UNAUTHORIZED', code: 'UNAUTHORIZED', message: 'Missing or invalid API key', statusCode: 401 },
    },
    403: { description: 'Forbidden', ...errorSchema,
      example: { error: 'FORBIDDEN', code: 'FORBIDDEN', message: 'Requester is not a community admin', statusCode: 403 },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Suspension appeals (#249)
// ---------------------------------------------------------------------------

const suspensionAppealItemSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    membershipId: { type: "string" },
    memberId: { type: "string" },
    wallet: walletAddressSchema,
    communityId: { type: "string" },
    memberStatement: { type: "string" },
    status: { type: "string", enum: ["pending", "approved", "denied"] },
    submittedAt: { type: "string", format: "date-time" },
    reviewerId: { type: "string", nullable: true },
    reviewedAt: { type: "string", format: "date-time", nullable: true },
    reviewerRationale: { type: "string", nullable: true },
  },
} as const;

export const submitSuspensionAppealSchema = {
  summary: "Submit a suspension appeal",
  tags: ["Appeals"],
  params: {
    type: "object",
    required: ["communityId", "wallet"],
    properties: {
      communityId: { type: "string", example: "community-mainnet-42" },
      wallet: walletAddressSchema,
    },
  },
  body: {
    type: "object",
    required: ["memberStatement"],
    properties: {
      memberStatement: {
        type: "string",
        minLength: 1,
        description: "Member's supporting statement for the appeal",
        example: "I believe my suspension was applied in error. I have not violated any community rules.",
      },
    },
    example: {
      memberStatement: "I believe my suspension was applied in error. I have not violated any community rules.",
    },
  },
  response: {
    201: {
      description: "Appeal created",
      ...suspensionAppealItemSchema,
      example: {
        id: "apl_01HZ9K3XB7E4F2WQMN8VDTG1R",
        membershipId: "mbsh_01HZ9K3XB7E4F2WQMN8VDTG1R",
        memberId: "mbr_01HZ9K3XB7E4F2WQMN8VDTG1R",
        wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        communityId: "community-mainnet-42",
        memberStatement: "I believe my suspension was applied in error. I have not violated any community rules.",
        status: "pending",
        submittedAt: "2026-07-28T12:00:00.000Z",
        reviewerId: null,
        reviewedAt: null,
        reviewerRationale: null,
      },
    },
    400: {
      description: "Validation error / not suspended",
      ...errorSchema,
      example: { error: "VALIDATION_ERROR", code: "VALIDATION_ERROR", message: "Member is not currently suspended", statusCode: 400 },
    },
    401: {
      description: "Unauthorized",
      ...errorSchema,
      example: { error: "UNAUTHORIZED", code: "UNAUTHORIZED", message: "Missing or invalid API key", statusCode: 401 },
    },
    403: {
      description: "Forbidden — not the member's wallet",
      ...errorSchema,
      example: { error: "FORBIDDEN", code: "FORBIDDEN", message: "Requester wallet does not match the member wallet", statusCode: 403 },
    },
    404: {
      description: "Member not found",
      ...errorSchema,
      example: { error: "NOT_FOUND", code: "NOT_FOUND", message: "Member not found", statusCode: 404 },
    },
    409: {
      description: "Pending appeal already exists",
      ...errorSchema,
      example: { error: "CONFLICT", code: "CONFLICT", message: "A pending appeal already exists for this member", statusCode: 409 },
    },
  },
} as const;

export const listSuspensionAppealsSchema = {
  summary: "List suspension appeals (admin review queue)",
  tags: ["Appeals"],
  params: {
    type: "object",
    required: ["communityId"],
    properties: {
      communityId: { type: "string", example: "community-mainnet-42" },
    },
  },
  querystring: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pending", "approved", "denied"] },
      page: { type: "integer", minimum: 1, default: 1 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    },
  },
  response: {
    200: {
      description: "Paginated appeals queue",
      type: "object",
      required: ["appeals", "pagination"],
      properties: {
        appeals: { type: "array", items: suspensionAppealItemSchema },
        pagination: {
          type: "object",
          required: ["page", "limit", "total", "totalPages"],
          properties: {
            page: { type: "integer" },
            limit: { type: "integer" },
            total: { type: "integer" },
            totalPages: { type: "integer" },
          },
        },
      },
      example: {
        appeals: [
          {
            id: "apl_01HZ9K3XB7E4F2WQMN8VDTG1R",
            membershipId: "mbsh_01HZ9K3XB7E4F2WQMN8VDTG1R",
            memberId: "mbr_01HZ9K3XB7E4F2WQMN8VDTG1R",
            wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
            communityId: "community-mainnet-42",
            memberStatement: "I believe my suspension was applied in error.",
            status: "pending",
            submittedAt: "2026-07-28T12:00:00.000Z",
            reviewerId: null,
            reviewedAt: null,
            reviewerRationale: null,
          },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      },
    },
    401: {
      description: "Unauthorized",
      ...errorSchema,
      example: { error: "UNAUTHORIZED", code: "UNAUTHORIZED", message: "Missing or invalid API key", statusCode: 401 },
    },
    403: {
      description: "Forbidden — not a community admin",
      ...errorSchema,
      example: { error: "FORBIDDEN", code: "FORBIDDEN", message: "Requester is not a community admin", statusCode: 403 },
    },
  },
} as const;

export const decideSuspensionAppealSchema = {
  summary: "Approve or deny a suspension appeal",
  tags: ["Appeals"],
  params: {
    type: "object",
    required: ["communityId", "appealId"],
    properties: {
      communityId: { type: "string", example: "community-mainnet-42" },
      appealId: { type: "string", example: "apl_01HZ9K3XB7E4F2WQMN8VDTG1R" },
    },
  },
  body: {
    type: "object",
    required: ["decision", "rationale"],
    properties: {
      decision: { type: "string", enum: ["approved", "denied"], example: "approved" },
      rationale: {
        type: "string",
        minLength: 1,
        description: "Required reviewer rationale recorded in audit_events",
        example: "Reviewed evidence; suspension was applied in error. Member is reinstated.",
      },
    },
    example: {
      decision: "approved",
      rationale: "Reviewed evidence; suspension was applied in error. Member is reinstated.",
    },
  },
  response: {
    200: {
      description: "Updated appeal",
      ...suspensionAppealItemSchema,
      example: {
        id: "apl_01HZ9K3XB7E4F2WQMN8VDTG1R",
        membershipId: "mbsh_01HZ9K3XB7E4F2WQMN8VDTG1R",
        memberId: "mbr_01HZ9K3XB7E4F2WQMN8VDTG1R",
        wallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        communityId: "community-mainnet-42",
        memberStatement: "I believe my suspension was applied in error.",
        status: "approved",
        submittedAt: "2026-07-28T12:00:00.000Z",
        reviewerId: "mbr_02HZ9K3XB7E4F2WQMN8VDTG2S",
        reviewedAt: "2026-07-28T14:00:00.000Z",
        reviewerRationale: "Reviewed evidence; suspension was applied in error. Member is reinstated.",
      },
    },
    400: {
      description: "Invalid transition / missing rationale",
      ...errorSchema,
      example: { error: "VALIDATION_ERROR", code: "VALIDATION_ERROR", message: "rationale is required", statusCode: 400 },
    },
    401: {
      description: "Unauthorized",
      ...errorSchema,
      example: { error: "UNAUTHORIZED", code: "UNAUTHORIZED", message: "Missing or invalid API key", statusCode: 401 },
    },
    403: {
      description: "Forbidden — not a community admin",
      ...errorSchema,
      example: { error: "FORBIDDEN", code: "FORBIDDEN", message: "Requester is not a community admin", statusCode: 403 },
    },
    404: {
      description: "Appeal not found",
      ...errorSchema,
      example: { error: "NOT_FOUND", code: "NOT_FOUND", message: "Appeal not found", statusCode: 404 },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/members/:wallet/score
// ---------------------------------------------------------------------------

export const getContributionScoreSchema = {
  summary: "Get contribution score for a member",
  tags: ["Contribution Scoring"],
  params: {
    type: "object",
    required: ["communityId", "wallet"],
    properties: {
      communityId: { type: "string", description: "Community identifier" },
      wallet: walletAddressSchema,
    },
  },
  response: {
    200: {
      description: "Contribution score for the member",
      type: "object",
      required: ["wallet", "communityId", "totalScore", "breakdown"],
      properties: {
        wallet: walletAddressSchema,
        communityId: { type: "string" },
        totalScore: { type: "number", description: "Aggregated contribution score" },
        breakdown: {
          type: "object",
          additionalProperties: { type: "number" },
          description: "Per-signal point breakdown",
        },
        history: {
          type: "array",
          description: "Recent recomputation history (most recent first)",
          items: {
            type: "object",
            required: ["totalScore", "breakdown", "createdAt"],
            properties: {
              totalScore: { type: "number" },
              breakdown: {
                type: "object",
                additionalProperties: { type: "number" },
              },
              explanations: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              triggerEventId: { type: "string", nullable: true },
              createdAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    404: { description: "Member not found", ...errorSchema },
  },
} as const;
