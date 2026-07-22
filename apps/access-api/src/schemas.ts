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

// ---------------------------------------------------------------------------
// Shared primitive fragments
// ---------------------------------------------------------------------------

/** EVM wallet address: 0x followed by exactly 40 hex characters. */
const walletAddressSchema = {
  type: 'string',
  pattern: '^0x[0-9a-fA-F]{40}$',
  description: 'EVM-compatible wallet address (checksummed or lowercase)',
} as const;

/** Standard error envelope returned by every access-api error response. */
const errorSchema = {
  type: 'object',
  required: ['error', 'code', 'message', 'statusCode'],
  properties: {
    error: { type: 'string', description: 'Machine-readable error identifier' },
    code: { type: 'string', description: 'HTTP status phrase / error code' },
    message: { type: 'string', description: 'Human-readable description' },
    statusCode: { type: 'integer', description: 'HTTP status code' },
    details: {
      description: 'Optional detail payload',
      oneOf: [{ type: 'string' }, { type: 'object' }],
    },
  },
} as const;

/** Minimal forbidden / auth error (routes that return a bare {error} object). */
const forbiddenSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
  },
} as const;

/** Role enum values mirroring shared-types Role. */
const roleEnum = ['admin', 'member', 'contributor'] as const;

/** MembershipState enum values mirroring shared-types MembershipState. */
const membershipStateEnum = ['invited', 'active', 'expired', 'suspended'] as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/memberships/:wallet
// ---------------------------------------------------------------------------

export const getMembershipsSchema = {
  summary: 'Get membership status summary for a wallet in a community',
  tags: ['Memberships'],
  params: {
    type: 'object',
    required: ['communityId', 'wallet'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
      wallet: walletAddressSchema,
    },
  },
  response: {
    200: {
      description: 'Membership summary for the wallet',
      type: 'object',
      properties: {
        wallet: walletAddressSchema,
        communities: {
          type: 'array',
          items: {
            type: 'object',
            required: ['communityId', 'state'],
            properties: {
              communityId: { type: 'string' },
              state: { type: 'string', enum: membershipStateEnum },
              expiresAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
        },
      },
    },
    404: {
      description: 'Wallet not found',
      ...errorSchema,
    },
    500: {
      description: 'Internal server error',
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/members/:wallet
// ---------------------------------------------------------------------------

export const getMemberProfileSchema = {
  summary: 'Get member profile with membership state and roles',
  tags: ['Members'],
  params: {
    type: 'object',
    required: ['communityId', 'wallet'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
      wallet: walletAddressSchema,
    },
  },
  response: {
    200: {
      description: 'Member profile',
      type: 'object',
      properties: {
        communityId: { type: 'string' },
        profile: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            displayName: { type: 'string' },
            bio: { type: 'string', nullable: true },
            avatarUrl: { type: 'string', nullable: true },
          },
        },
        membership: {
          type: 'object',
          properties: {
            state: { type: 'string', enum: membershipStateEnum },
            expiresAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        roles: {
          type: 'array',
          items: { type: 'string', enum: roleEnum },
        },
      },
    },
    400: {
      description: 'Validation error',
      ...errorSchema,
    },
    404: {
      description: 'Member not found',
      ...errorSchema,
    },
    500: {
      description: 'Internal server error',
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/communities/:communityId/members/:wallet/roles
// ---------------------------------------------------------------------------

export const assignMemberRoleSchema = {
  summary: 'Assign a role to a community member',
  tags: ['Members', 'Roles'],
  params: {
    type: 'object',
    required: ['communityId', 'wallet'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
      wallet: walletAddressSchema,
    },
  },
  body: {
    type: 'object',
    required: ['role'],
    properties: {
      role: {
        type: 'string',
        enum: roleEnum,
        description: 'Role to assign',
      },
    },
  },
  response: {
    200: {
      description: 'Role assigned successfully',
      type: 'object',
      required: ['communityId', 'wallet', 'role', 'assigned', 'removed'],
      properties: {
        communityId: { type: 'string' },
        wallet: walletAddressSchema,
        role: { type: 'string', enum: roleEnum },
        assigned: { type: 'boolean' },
        removed: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
    400: {
      description: 'Validation error (invalid wallet, unknown community, or unrecognized role)',
      ...errorSchema,
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
// DELETE /v1/communities/:communityId/members/:wallet/roles/:role
// ---------------------------------------------------------------------------

export const removeMemberRoleSchema = {
  summary: 'Remove a role from a community member',
  tags: ['Members', 'Roles'],
  params: {
    type: 'object',
    required: ['communityId', 'wallet', 'role'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
      wallet: walletAddressSchema,
      role: { type: 'string', enum: roleEnum, description: 'Role to remove' },
    },
  },
  response: {
    200: {
      description: 'Role removed successfully',
      type: 'object',
      required: ['communityId', 'wallet', 'role', 'assigned', 'removed'],
      properties: {
        communityId: { type: 'string' },
        wallet: walletAddressSchema,
        role: { type: 'string', enum: roleEnum },
        assigned: { type: 'boolean' },
        removed: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
    400: {
      description: 'Validation error (invalid wallet, unknown community, or unrecognized role)',
      ...errorSchema,
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
// POST /v1/communities/:communityId/overrides
// ---------------------------------------------------------------------------

export const createAccessOverrideSchema = {
  summary: 'Create or update an access override for a wallet/resource pair',
  tags: ['Overrides'],
  params: {
    type: 'object',
    required: ['communityId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
    },
  },
  body: {
    type: 'object',
    required: ['wallet', 'resource', 'effect'],
    properties: {
      wallet: walletAddressSchema,
      resource: { type: 'string', description: 'Resource identifier' },
      effect: {
        type: 'string',
        enum: ['ALLOW', 'DENY'],
        description: 'Override effect',
      },
      reason: {
        type: 'string',
        description: 'Human-readable reason for the override',
        nullable: true,
      },
      expiresAt: {
        type: 'string',
        format: 'date-time',
        description: 'Optional ISO 8601 expiry timestamp',
        nullable: true,
      },
    },
  },
  response: {
    200: {
      description: 'Override created or updated',
      type: 'object',
      required: ['communityId', 'wallet', 'resource', 'effect', 'created', 'removed'],
      properties: {
        communityId: { type: 'string' },
        wallet: walletAddressSchema,
        resource: { type: 'string' },
        effect: { type: 'string', enum: ['ALLOW', 'DENY'] },
        created: { type: 'boolean' },
        removed: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
    400: {
      description: 'Validation error — missing required fields',
      ...errorSchema,
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
  summary: 'Revoke an access override for a wallet/resource pair',
  tags: ['Overrides'],
  params: {
    type: 'object',
    required: ['communityId', 'wallet', 'resource'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
      wallet: walletAddressSchema,
      resource: { type: 'string', description: 'Resource identifier' },
    },
  },
  response: {
    200: {
      description: 'Override revoked',
      type: 'object',
      required: ['communityId', 'wallet', 'resource', 'effect', 'created', 'removed'],
      properties: {
        communityId: { type: 'string' },
        wallet: walletAddressSchema,
        resource: { type: 'string' },
        effect: { type: 'string', enum: ['ALLOW', 'DENY'] },
        created: { type: 'boolean' },
        removed: { type: 'boolean' },
        message: { type: 'string' },
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
// Badge shared fragments
// ---------------------------------------------------------------------------

const badgeItemSchema = {
  type: 'object',
  required: ['id', 'memberId', 'label', 'issuedAt'],
  properties: {
    id: { type: 'string' },
    memberId: { type: 'string' },
    label: { type: 'string' },
    issuedAt: { type: 'string', format: 'date-time' },
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/communities/:communityId/members/:wallet/badges
// ---------------------------------------------------------------------------

export const assignBadgeSchema = {
  summary: 'Assign a badge to a community member',
  tags: ['Members', 'Badges'],
  params: {
    type: 'object',
    required: ['communityId', 'wallet'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
      wallet: walletAddressSchema,
    },
  },
  body: {
    type: 'object',
    required: ['label'],
    properties: {
      label: {
        type: 'string',
        minLength: 1,
        description: 'Badge label to assign',
      },
    },
  },
  response: {
    200: {
      description: 'Badge assigned successfully',
      type: 'object',
      required: ['communityId', 'wallet', 'assigned', 'removed'],
      properties: {
        communityId: { type: 'string' },
        wallet: walletAddressSchema,
        badge: badgeItemSchema,
        assigned: { type: 'boolean' },
        removed: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
    400: {
      description: 'Validation error (invalid wallet, unknown community, or missing label)',
      ...errorSchema,
    },
    403: {
      description: 'Forbidden — requester does not have permission',
      ...forbiddenSchema,
    },
    404: {
      description: 'Target wallet is not a member of the community',
      ...errorSchema,
    },
    500: {
      description: 'Internal server error',
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/members/:wallet/badges
// ---------------------------------------------------------------------------

export const listBadgesSchema = {
  summary: 'List badges assigned to a community member',
  tags: ['Members', 'Badges'],
  params: {
    type: 'object',
    required: ['communityId', 'wallet'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
      wallet: walletAddressSchema,
    },
  },
  response: {
    200: {
      description: 'Badges for the member',
      type: 'object',
      required: ['communityId', 'wallet', 'badges'],
      properties: {
        communityId: { type: 'string' },
        wallet: walletAddressSchema,
        badges: {
          type: 'array',
          items: badgeItemSchema,
        },
      },
    },
    400: {
      description: 'Validation error (invalid wallet or unknown community)',
      ...errorSchema,
    },
    404: {
      description: 'Target wallet is not a member of the community',
      ...errorSchema,
    },
    500: {
      description: 'Internal server error',
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// DELETE /v1/communities/:communityId/members/:wallet/badges/:badgeId
// ---------------------------------------------------------------------------

export const revokeBadgeSchema = {
  summary: 'Revoke a badge from a community member',
  tags: ['Members', 'Badges'],
  params: {
    type: 'object',
    required: ['communityId', 'wallet', 'badgeId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
      wallet: walletAddressSchema,
      badgeId: { type: 'string', description: 'Badge identifier' },
    },
  },
  response: {
    200: {
      description: 'Badge revoked (or was already absent)',
      type: 'object',
      required: ['communityId', 'wallet', 'assigned', 'removed'],
      properties: {
        communityId: { type: 'string' },
        wallet: walletAddressSchema,
        assigned: { type: 'boolean' },
        removed: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
    400: {
      description: 'Validation error (invalid wallet or unknown community)',
      ...errorSchema,
    },
    403: {
      description: 'Forbidden — requester does not have permission',
      ...forbiddenSchema,
    },
    404: {
      description: 'Target wallet is not a member of the community',
      ...errorSchema,
    },
    500: {
      description: 'Internal server error',
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/access/check
// ---------------------------------------------------------------------------

export const accessCheckSchema = {
  summary: 'Check whether a wallet has access to a resource in a community',
  tags: ['Access'],
  body: {
    type: 'object',
    required: ['wallet', 'communityId', 'resource'],
    properties: {
      wallet: walletAddressSchema,
      communityId: { type: 'string', description: 'Community identifier' },
      resource: { type: 'string', description: 'Resource identifier' },
    },
  },
  response: {
    200: {
      description: 'Access decision',
      type: 'object',
      required: ['allowed', 'code'],
      properties: {
        allowed: { type: 'boolean', description: 'Whether access is granted' },
        code: {
          type: 'string',
          enum: ['ALLOW', 'DENY'],
          description: 'Machine-readable decision code',
        },
        reasons: {
          type: 'array',
          items: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
        effectiveRoles: {
          type: 'array',
          items: { type: 'string', enum: roleEnum },
          nullable: true,
        },
        membershipState: {
          type: 'string',
          enum: membershipStateEnum,
          nullable: true,
        },
      },
    },
    400: {
      description: 'Validation error — missing required fields',
      ...errorSchema,
    },
    500: {
      description: 'Internal server error',
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/members  (admin listing)
// ---------------------------------------------------------------------------

export const listCommunityMembersSchema = {
  summary: 'List community members (admin)',
  tags: ['Members'],
  params: {
    type: 'object',
    required: ['communityId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        enum: roleEnum,
        description: 'Filter members by role',
      },
    },
  },
  response: {
    200: {
      description: 'Paginated member list',
      type: 'object',
      required: ['members'],
      properties: {
        members: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              wallet: walletAddressSchema,
              displayName: { type: 'string', nullable: true },
              state: { type: 'string', enum: membershipStateEnum },
              roles: {
                type: 'array',
                items: { type: 'string', enum: roleEnum },
              },
            },
          },
        },
      },
    },
    403: {
      description: 'Forbidden — requester is not a community admin',
      ...forbiddenSchema,
    },
    500: {
      description: 'Internal server error',
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/dead-letter-events
// ---------------------------------------------------------------------------

/** Shared dead-letter event item shape. */
const deadLetterEventItemSchema = {
  type: 'object',
  required: ['id', 'originalEventId', 'eventType', 'failureReason', 'retryCount', 'status', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    originalEventId: { type: 'string', format: 'uuid' },
    eventType: { type: 'string' },
    entityId: { type: 'string', nullable: true },
    entityType: { type: 'string', nullable: true },
    communityId: { type: 'string', nullable: true },
    payload: { type: 'object', additionalProperties: true },
    failureReason: { type: 'string' },
    retryCount: { type: 'integer', minimum: 0 },
    status: { type: 'string', enum: ['pending', 'retried', 'resolved'] },
    createdAt: { type: 'string', format: 'date-time' },
    resolvedAt: { type: 'string', format: 'date-time', nullable: true },
  },
} as const;

export const listDeadLetterEventsSchema = {
  summary: 'List dead-lettered webhook delivery events for a community',
  tags: ['Dead Letter'],
  params: {
    type: 'object',
    required: ['communityId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'retried', 'resolved'],
        description: 'Filter events by status',
      },
    },
  },
  response: {
    200: {
      description: 'List of dead-letter events',
      type: 'object',
      required: ['events'],
      properties: {
        events: {
          type: 'array',
          items: deadLetterEventItemSchema,
        },
      },
    },
    403: {
      description: 'Forbidden — requester is not a community admin',
      ...forbiddenSchema,
    },
    500: {
      description: 'Internal server error',
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// POST /v1/communities/:communityId/dead-letter-events/:id/retry
// ---------------------------------------------------------------------------

export const retryDeadLetterEventSchema = {
  summary: 'Re-enqueue a dead-lettered event for redelivery',
  tags: ['Dead Letter'],
  params: {
    type: 'object',
    required: ['communityId', 'id'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
      id: { type: 'string', format: 'uuid', description: 'Dead-letter event ID' },
    },
  },
  response: {
    200: {
      description: 'Event re-enqueued successfully',
      type: 'object',
      required: ['newEventId'],
      properties: {
        newEventId: {
          type: 'string',
          format: 'uuid',
          description: 'ID of the newly created pending outbox event',
        },
      },
    },
    403: {
      description: 'Forbidden — requester is not a community admin',
      ...forbiddenSchema,
    },
    404: {
      description: 'Dead-letter event not found',
      ...errorSchema,
    },
    409: {
      description: 'Event has already been retried or resolved',
      ...forbiddenSchema,
    },
    500: {
      description: 'Internal server error',
      ...forbiddenSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /v1/communities/:communityId/audit-events
// ---------------------------------------------------------------------------

export const listAuditEventsSchema = {
  summary: 'List and filter audit events for a community (admin only)',
  tags: ['Audit'],
  params: {
    type: 'object',
    required: ['communityId'],
    properties: {
      communityId: { type: 'string', description: 'Community identifier' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      actorWallet: {
        type: 'string',
        description: 'Filter events by actor wallet address',
      },
      eventType: {
        type: 'string',
        enum: [
          'ACCESS_CHECK',
          'MEMBERSHIP_CREATED',
          'MEMBERSHIP_UPDATED',
          'MEMBERSHIP_DELETED',
          'POLICY_EVALUATION',
          'MEMBERSHIP_RECONCILED',
          'OTHER',
        ],
        description: 'Filter events by event type',
      },
      resource: {
        type: 'string',
        description: 'Filter events by resource identifier',
      },
      from: {
        type: 'string',
        format: 'date-time',
        description: 'ISO 8601 timestamp to filter events created at or after',
      },
      to: {
        type: 'string',
        format: 'date-time',
        description: 'ISO 8601 timestamp to filter events created at or before',
      },
      page: {
        type: 'integer',
        minimum: 1,
        default: 1,
        description: 'Page number for pagination',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 20,
        description: 'Number of events per page',
      },
    },
  },
  response: {
    200: {
      description: 'Paginated audit events list',
      type: 'object',
      required: ['events', 'pagination'],
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'eventType', 'createdAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              eventType: { type: 'string' },
              walletId: { type: 'string', nullable: true },
              communityId: { type: 'string', nullable: true },
              resource: { type: 'string', nullable: true },
              policyRule: { type: 'string', nullable: true },
              decision: { type: 'string', nullable: true },
              reasonCode: { type: 'string', nullable: true },
              beforeState: { type: 'object', additionalProperties: true, nullable: true },
              afterState: { type: 'object', additionalProperties: true, nullable: true },
              correlationId: { type: 'string', nullable: true },
              chainId: { type: 'integer', nullable: true },
              txHash: { type: 'string', nullable: true },
              blockNumber: { type: 'integer', nullable: true },
              logIndex: { type: 'integer', nullable: true },
              membershipStateVersion: { type: 'string', nullable: true },
              roleStateVersion: { type: 'string', nullable: true },
              recordHash: { type: 'string', nullable: true },
              previousRecordHash: { type: 'string', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        pagination: {
          type: 'object',
          required: ['page', 'limit', 'total', 'totalPages'],
          properties: {
            page: { type: 'integer' },
            limit: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
      },
    },
    400: {
      description: 'Validation error (e.g. invalid date format)',
      ...errorSchema,
    },
    403: {
      description: 'Forbidden — requester is not a community admin',
      ...forbiddenSchema,
    },
    500: {
      description: 'Internal server error',
      ...forbiddenSchema,
    },
  },
} as const;

