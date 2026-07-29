export const API_CONTRACT = {
  membershipsByWallet: {
    method: "GET",
    pathTemplate: "/v1/communities/:communityId/memberships/:wallet",
    samplePath:
      "/v1/communities/community-1/memberships/0x1234567890abcdef1234567890abcdef12345678",
    successStatus: 200,
    successResponse: {
      wallet: "0x1234567890abcdef1234567890abcdef12345678",
      communities: [
        { communityId: "community-1", state: "active", expiresAt: null },
      ],
    },
    errorResponse: {
      404: {
        error: {
          code: "NOT_FOUND",
          message: "Wallet not found",
        },
      },
    },
  },
  memberProfileByWallet: {
    method: "GET",
    pathTemplate: "/v1/communities/:communityId/members/:wallet",
    samplePath:
      "/v1/communities/community-1/members/0x1234567890abcdef1234567890abcdef12345678",
    successStatus: 200,
    successResponse: {
      communityId: "community-1",
      profile: { id: "p1", displayName: "Alice", bio: "Hello" },
      membership: { state: "active", expiresAt: null },
      roles: ["admin"],
    },
    errorResponse: {
      400: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          details: "wallet query parameter is required",
        },
      },
      404: {
        error: {
          code: "NOT_FOUND",
          message: "Member not found",
        },
      },
    },
  },
  accessCheck: {
    method: "POST",
    pathTemplate: "/v1/access/check",
    samplePath: "/v1/access/check",
    requestBody: {
      wallet: "0x1234567890abcdef1234567890abcdef12345678",
      communityId: "community-1",
      resource: "resource-1",
    },
    successStatus: 200,
    successResponse: {
      allowed: true,
      code: "ALLOW",
      membershipState: "active",
    },
    errorResponse: {
      400: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          details: "Missing required fields: wallet",
        },
      },
    },
  },
  communityMembers: {
    method: 'GET',
    pathTemplate: '/v1/communities/:communityId/members',
    samplePath: '/v1/communities/community-1/members',
    samplePathWithRole: '/v1/communities/community-1/members?role=admin',
    samplePathWithPagination: '/v1/communities/community-1/members?page=2&pageSize=1&sort=joinedAt',
    successStatus: 200,
    successResponse: {
      data: [
        {
          wallet: "0x1111111111111111111111111111111111111111",
          displayName: "Alice",
          state: "active",
          roles: ["admin"],
          joinedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          wallet: "0x2222222222222222222222222222222222222222",
          displayName: "Bob",
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
    errorResponse: {
      404: {
        error: {
          code: "NOT_FOUND",
          message: "Community not found",
        },
      },
    },
  },
  assignMemberRole: {
    method: "POST",
    pathTemplate: "/v1/communities/:communityId/members/:wallet/roles",
    samplePath:
      "/v1/communities/community-1/members/0x1234567890abcdef1234567890abcdef12345678/roles",
    requestBody: { role: "admin" },
    successStatus: 200,
    successResponse: {
      communityId: "community-1",
      wallet: "0x1234567890abcdef1234567890abcdef12345678",
      role: "admin",
      assigned: true,
      removed: false,
      message: "Role assigned",
    },
  },
  removeMemberRole: {
    method: "DELETE",
    pathTemplate: "/v1/communities/:communityId/members/:wallet/roles/:role",
    samplePath:
      "/v1/communities/community-1/members/0x1234567890abcdef1234567890abcdef12345678/roles/admin",
    successStatus: 200,
    successResponse: {
      communityId: "community-1",
      wallet: "0x1234567890abcdef1234567890abcdef12345678",
      role: "admin",
      assigned: false,
      removed: true,
      message: "Role removed",
    },
  },
  communityRoles: {
    method: 'GET',
    pathTemplate: '/v1/communities/:communityId/roles',
    samplePath: '/v1/communities/community-1/roles',
    successStatus: 200,
    successResponse: {
      roles: [
        {
          name: 'admin' as const,
          description: 'Administrator with full permissions',
          implies: ['contributor' as const, 'member' as const],
        },
        {
          name: 'contributor' as const,
          description: 'Contributor with write permissions',
          implies: ['member' as const],
        },
        {
          name: 'member' as const,
          description: 'Standard member with basic permissions',
          implies: [],
        },
      ],
    },
    errorResponse: {
      404: {
        error: {
          code: 'NOT_FOUND',
          message: 'Community not found',
        }
      },
    },
  },
} as const;

export type ApiContract = typeof API_CONTRACT;

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'EXPIRED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | string; // Keep string for any dynamic errors but provide autocomplete for standard ones

/**
 * Standardised error envelope returned by every access-api endpoint.
 *
 * SDK consumers: catch `GuildPassApiError` to access these fields programmatically.
 * API consumers: check `error`/`code` for machine-readable error classification.
 */
export interface ApiErrorResponse {
  error: {
    /** Machine-readable error identifier (e.g. `NOT_FOUND`, `VALIDATION_ERROR`). */
    code: ApiErrorCode;
    /** Human-readable description suitable for developer logs or UI hints. */
    message: string;
    /** Optional machine- or human-readable detail payload. */
    details?: string | Record<string, unknown>;
  };
}
