export const API_CONTRACT = {
  membershipsByWallet: {
    method: 'GET',
    pathTemplate: '/v1/communities/:communityId/memberships/:wallet',
    samplePath: '/v1/communities/community-1/memberships/0x1234567890abcdef1234567890abcdef12345678',
    successStatus: 200,
    successResponse: {
      wallet: '0x1234567890abcdef1234567890abcdef12345678',
      communities: [
        { communityId: 'community-1', state: 'active', expiresAt: null },
      ],
    },
    errorResponse: {
      404: { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Wallet not found', statusCode: 404 },
    },
  },
  memberProfileByWallet: {
    method: 'GET',
    pathTemplate: '/v1/communities/:communityId/members/:wallet',
    samplePath: '/v1/communities/community-1/members/0x1234567890abcdef1234567890abcdef12345678',
    successStatus: 200,
    successResponse: {
      communityId: 'community-1',
      profile: { id: 'p1', displayName: 'Alice', bio: 'Hello' },
      membership: { state: 'active', expiresAt: null },
      roles: ['admin'],
    },
    errorResponse: {
      400: { error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'Validation failed', statusCode: 400, details: 'wallet query parameter is required' },
      404: { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Member not found', statusCode: 404 },
    },
  },
  accessCheck: {
    method: 'POST',
    pathTemplate: '/v1/access/check',
    samplePath: '/v1/access/check',
    requestBody: {
      wallet: '0x1234567890abcdef1234567890abcdef12345678',
      communityId: 'community-1',
      resource: 'resource-1',
    },
    successStatus: 200,
    successResponse: {
      allowed: true,
      code: 'ALLOW',
      membershipState: 'active',
    },
    errorResponse: {
      400: { error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'Validation failed', statusCode: 400, details: 'Missing required fields: wallet' },
    },
  },
  communityMembers: {
    method: 'GET',
    pathTemplate: '/v1/communities/:communityId/members',
    samplePath: '/v1/communities/community-1/members',
    samplePathWithRole: '/v1/communities/community-1/members?role=admin',
    successStatus: 200,
    successResponse: {
      members: [
        {
          wallet: '0x1111111111111111111111111111111111111111',
          displayName: 'Alice',
          state: 'active',
          roles: ['admin'],
        },
        {
          wallet: '0x2222222222222222222222222222222222222222',
          displayName: 'Bob',
          state: 'active',
          roles: ['member'],
        },
      ],
    },
    errorResponse: {
      404: { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Community not found', statusCode: 404 },
    },
  },
  assignMemberRole: {
    method: 'POST',
    pathTemplate: '/v1/communities/:communityId/members/:wallet/roles',
    samplePath: '/v1/communities/community-1/members/0x1234567890abcdef1234567890abcdef12345678/roles',
    requestBody: { role: 'admin' },
    successStatus: 200,
    successResponse: {
      communityId: 'community-1',
      wallet: '0x1234567890abcdef1234567890abcdef12345678',
      role: 'admin',
      assigned: true,
      removed: false,
      message: 'Role assigned',
    },
  },
  removeMemberRole: {
    method: 'DELETE',
    pathTemplate: '/v1/communities/:communityId/members/:wallet/roles/:role',
    samplePath: '/v1/communities/community-1/members/0x1234567890abcdef1234567890abcdef12345678/roles/admin',
    successStatus: 200,
    successResponse: {
      communityId: 'community-1',
      wallet: '0x1234567890abcdef1234567890abcdef12345678',
      role: 'admin',
      assigned: false,
      removed: true,
      message: 'Role removed',
    },
  },
} as const;

export type ApiContract = typeof API_CONTRACT;

/**
 * Standardised error envelope returned by every access-api endpoint.
 *
 * SDK consumers: catch `GuildPassApiError` to access these fields programmatically.
 * API consumers: check `error`/`code` for machine-readable error classification.
 */
export interface ApiErrorResponse {
  /** Machine-readable error identifier (e.g. `NOT_FOUND`, `VALIDATION_ERROR`). */
  error: string;
  /** HTTP status phrase (e.g. `NOT_FOUND`). Mirrors `error` for backward compatibility. */
  code: string;
  /** Human-readable description suitable for developer logs or UI hints. */
  message: string;
  /** HTTP status code (e.g. 404). */
  statusCode: number;
  /** Optional machine- or human-readable detail payload. */
  details?: string | Record<string, unknown>;
}
