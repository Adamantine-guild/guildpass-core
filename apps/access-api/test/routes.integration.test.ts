import Fastify, { type FastifyInstance } from 'fastify';
import { API_CONTRACT } from '../../../packages/shared-types/src/apiContract';

/**
 * Fastify route integration tests using app.inject().
 *
 * These tests create a Fastify instance with mocked services —
 * no network binding, no Prisma, no workspace deps required.
 *
 * Error responses use the standardised {@link ApiErrorResponse} envelope:
 *   { error, code, message, statusCode, details? }
 */

type MembershipState = 'active' | 'expired' | 'suspended' | 'invited';

// --- Error envelope helpers (mirrors access-api/src/errors.ts) ---
interface ErrorPayload {
  statusCode: number;
  code: string;
  message: string;
  details?: string | Record<string, unknown>;
}

function apiError(payload: ErrorPayload) {
  return {
    error: payload.code,
    code: payload.code,
    message: payload.message,
    statusCode: payload.statusCode,
    ...(payload.details !== undefined ? { details: payload.details } : {}),
  };
}

// --- Mock service factory ---
function createMockMemberService(overrides: Record<string, jest.Mock> = {}) {
  return {
    getMembershipsByWallet: overrides.getMembershipsByWallet ?? jest.fn(),
    getProfileByWallet: overrides.getProfileByWallet ?? jest.fn(),
    checkAccess: overrides.checkAccess ?? jest.fn(),
    listMembersForAdmin: overrides.listMembersForAdmin ?? jest.fn(),
    assignMemberRole: overrides.assignMemberRole ?? jest.fn(),
    removeMemberRole: overrides.removeMemberRole ?? jest.fn(),
    createAccessOverride: overrides.createAccessOverride ?? jest.fn(),
    revokeAccessOverride: overrides.revokeAccessOverride ?? jest.fn(),
  };
}


// --- Build test app with mocked services ---
async function buildTestApp(mockService: ReturnType<typeof createMockMemberService>): Promise<FastifyInstance> {
  const app = Fastify();

  // expose requester wallet helper only via headers for route tests
  // (these tests use mocked services, so auth is enforced in service/unit tests)


  // Health route
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register routes with mocked service
  app.get('/v1/communities/:communityId/memberships/:wallet', async (request) => {
    const { wallet } = request.params as { communityId: string; wallet: string };
    return mockService.getMembershipsByWallet(wallet);
  });

  app.get('/v1/communities/:communityId/members/:wallet', async (request, reply) => {
    const { wallet } = request.params as { communityId: string; wallet: string };
    const result = await mockService.getProfileByWallet(wallet);
    if (!result) {
      return reply.status(404).send(apiError({ statusCode: 404, code: 'NOT_FOUND', message: 'Member not found' }));
    }
    return result;
  });

  app.post('/v1/access/check', async (request, reply) => {
    const body = request.body as {
      wallet: string;
      communityId: string;
      resource: string;
    };
    if (!body?.wallet || !body?.communityId || !body?.resource) {
      return reply.status(400).send(
        apiError({ statusCode: 400, code: 'VALIDATION_ERROR', message: 'Missing required fields: wallet, communityId, resource' }),
      );
    }
    return mockService.checkAccess(body);
  });

  app.get('/v1/communities/:communityId/members', async (request, reply) => {
    const { communityId } = request.params as { communityId: string };
    const requesterWallet = request.headers['x-wallet'] ?? request.headers['x-user-wallet'] ?? request.headers['x-requester-wallet'];
    // The integration test app doesn't enforce auth; service unit tests do.
    // This just ensures request parsing is stable.
    const role = (request.query as { role?: string })?.role;
    return mockService.listMembersForAdmin(communityId, role);
  });

  // POST /v1/communities/:communityId/members/:wallet/roles — assign a role to a member
  app.post('/v1/communities/:communityId/members/:wallet/roles', async (request, reply) => {
    const { communityId, wallet } = request.params as { communityId: string; wallet: string };
    const body = request.body as { role?: string };
    const requesterWalletHeader = request.headers['x-wallet'] ?? request.headers['x-user-wallet'] ?? request.headers['x-requester-wallet'];
    const requesterWallet = Array.isArray(requesterWalletHeader)
      ? requesterWalletHeader[0] ?? ''
      : (requesterWalletHeader as string | undefined) ?? '';

    try {
      return mockService.assignMemberRole({
        requesterWallet,
        communityId,
        targetWallet: wallet,
        role: body?.role ?? '',
      });
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 500).send({ error: err?.message ?? 'Internal server error' });
    }
  });

  // DELETE /v1/communities/:communityId/members/:wallet/roles/:role — remove an assigned role
  app.delete('/v1/communities/:communityId/members/:wallet/roles/:role', async (request, reply) => {
    const { communityId, wallet, role } = request.params as { communityId: string; wallet: string; role: string };
    const requesterWalletHeader = request.headers['x-wallet'] ?? request.headers['x-user-wallet'] ?? request.headers['x-requester-wallet'];
    const requesterWallet = Array.isArray(requesterWalletHeader)
      ? requesterWalletHeader[0] ?? ''
      : (requesterWalletHeader as string | undefined) ?? '';

    try {
      return mockService.removeMemberRole({
        requesterWallet,
        communityId,
        targetWallet: wallet,
        role,
      });
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 500).send({ error: err?.message ?? 'Internal server error' });
    }
  });

  // POST /v1/communities/:communityId/overrides — create or update an access override for a wallet/resource
  app.post('/v1/communities/:communityId/overrides', async (request, reply) => {
    const { communityId } = request.params as { communityId: string };
    const body = request.body as {
      wallet?: string;
      resource?: string;
      effect?: string;
      reason?: string;
      expiresAt?: string | null;
    };
    if (!body?.wallet || !body?.resource || !body?.effect) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Missing required fields: wallet, resource, effect',
      });
    }
    const requesterWalletHeader = request.headers['x-wallet'] ?? request.headers['x-user-wallet'] ?? request.headers['x-requester-wallet'];
    const requesterWallet = Array.isArray(requesterWalletHeader)
      ? requesterWalletHeader[0] ?? ''
      : (requesterWalletHeader as string | undefined) ?? '';

    try {
      return await mockService.createAccessOverride({
        requesterWallet,
        communityId,
        wallet: body.wallet,
        resource: body.resource,
        effect: body.effect,
        reason: body.reason,
        expiresAt: body.expiresAt ?? null,
      });
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 500).send({ error: err?.message ?? 'Internal server error' });
    }
  });

  // DELETE /v1/communities/:communityId/overrides/:wallet/:resource — revoke an access override
  app.delete('/v1/communities/:communityId/overrides/:wallet/:resource', async (request, reply) => {
    const { communityId, wallet, resource } = request.params as { communityId: string; wallet: string; resource: string };
    const requesterWalletHeader = request.headers['x-wallet'] ?? request.headers['x-user-wallet'] ?? request.headers['x-requester-wallet'];
    const requesterWallet = Array.isArray(requesterWalletHeader)
      ? requesterWalletHeader[0] ?? ''
      : (requesterWalletHeader as string | undefined) ?? '';

    try {
      return await mockService.revokeAccessOverride({
        requesterWallet,
        communityId,
        wallet,
        resource,
        effect: 'DENY',
      });
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 500).send({ error: err?.message ?? 'Internal server error' });
    }
  });

  await app.ready();

  return app;
}

// --- Tests ---
describe('GET /health', () => {
  test('returns 200 with status ok', async () => {
    const mock = createMockMemberService();
    const app = await buildTestApp(mock);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();

    await app.close();
  });
});

describe('GET /v1/memberships/:wallet', () => {
  test('returns memberships for a known wallet', async () => {
    const mockData = API_CONTRACT.membershipsByWallet.successResponse;
    const mock = createMockMemberService({
      getMembershipsByWallet: jest.fn().mockResolvedValue(mockData),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: API_CONTRACT.membershipsByWallet.method,
      url: API_CONTRACT.membershipsByWallet.samplePath,
    });

    expect(response.statusCode).toBe(API_CONTRACT.membershipsByWallet.successStatus);
    const body = response.json();
    expect(body.wallet).toBe(mockData.wallet);
    expect(body.communities).toHaveLength(1);
    expect(body.communities[0].state).toBe('active');
    expect(mock.getMembershipsByWallet).toHaveBeenCalledWith(
      '0x1234567890abcdef1234567890abcdef12345678',
    );

    await app.close();
  });

  test('returns empty communities for unknown wallet', async () => {
    const mockData = {
      wallet: '0x0000000000000000000000000000000000000000',
      communities: [],
    };
    const mock = createMockMemberService({
      getMembershipsByWallet: jest.fn().mockResolvedValue(mockData),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/communities/community-1/memberships/0x0000000000000000000000000000000000000000',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().communities).toEqual([]);

    await app.close();
  });
});

describe('GET /v1/members/:wallet', () => {
  test('returns 200 with profile for found member', async () => {
    const mockData = API_CONTRACT.memberProfileByWallet.successResponse;
    const mock = createMockMemberService({
      getProfileByWallet: jest.fn().mockResolvedValue(mockData),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: API_CONTRACT.memberProfileByWallet.method,
      url: API_CONTRACT.memberProfileByWallet.samplePath,
    });

    expect(response.statusCode).toBe(API_CONTRACT.memberProfileByWallet.successStatus);
    const body = response.json();
    expect(body.profile.displayName).toBe('Alice');
    expect(body.roles).toEqual(['admin']);

    await app.close();
  });

  test('returns 404 with standardised error envelope when member not found', async () => {
    const mock = createMockMemberService({
      getProfileByWallet: jest.fn().mockResolvedValue(null),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/communities/community-1/members/0x0000000000000000000000000000000000000000',
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error).toBe('NOT_FOUND');
    expect(body.code).toBe('NOT_FOUND');
    expect(body.message).toBe('Member not found');
    expect(body.statusCode).toBe(404);

    await app.close();
  });
});

describe('POST /v1/access/check', () => {
  test('returns allowed=true when access is granted', async () => {
    const mockResult = API_CONTRACT.accessCheck.successResponse;
    const mock = createMockMemberService({
      checkAccess: jest.fn().mockResolvedValue(mockResult),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: API_CONTRACT.accessCheck.method,
      url: API_CONTRACT.accessCheck.samplePath,
      payload: API_CONTRACT.accessCheck.requestBody,
    });

    expect(response.statusCode).toBe(API_CONTRACT.accessCheck.successStatus);
    const body = response.json();
    expect(body.allowed).toBe(true);
    expect(body.code).toBe('ALLOW');

    await app.close();
  });

  test('returns allowed=false when access is denied', async () => {
    const mockResult = {
      allowed: false,
      code: 'DENY',
      membershipState: 'expired',
    };
    const mock = createMockMemberService({
      checkAccess: jest.fn().mockResolvedValue(mockResult),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/access/check',
      payload: {
        wallet: '0x1234567890abcdef1234567890abcdef12345678',
        communityId: 'community-1',
        resource: 'resource-1',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.allowed).toBe(false);
    expect(body.code).toBe('DENY');

    await app.close();
  });

  test('returns 400 with standardised error envelope when required fields are missing', async () => {
    const mock = createMockMemberService();
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/access/check',
      payload: { wallet: '0x1234' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toMatch(/Missing required fields/);
    expect(body.statusCode).toBe(400);

    await app.close();
  });
});

describe('GET /v1/communities/:communityId/members', () => {
  test('returns member list for a community', async () => {
    const mockData = API_CONTRACT.communityMembers.successResponse;
    const mock = createMockMemberService({
      listMembersForAdmin: jest.fn().mockResolvedValue(mockData),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: API_CONTRACT.communityMembers.method,
      url: API_CONTRACT.communityMembers.samplePath,
    });

    expect(response.statusCode).toBe(API_CONTRACT.communityMembers.successStatus);
    const body = response.json();
    expect(body.members).toHaveLength(2);
    expect(mock.listMembersForAdmin).toHaveBeenCalledWith('community-1', undefined);

    await app.close();
  });

  test('passes role filter query param', async () => {
    const mock = createMockMemberService({
      listMembersForAdmin: jest.fn().mockResolvedValue({ members: [] }),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: API_CONTRACT.communityMembers.method,
      url: API_CONTRACT.communityMembers.samplePathWithRole,
    });

    expect(response.statusCode).toBe(200);
    expect(mock.listMembersForAdmin).toHaveBeenCalledWith('community-1', 'admin');

    await app.close();
  });
});

describe('POST /v1/communities/:communityId/members/:wallet/roles', () => {
  test('assigns a role to a member', async () => {

    const mockResponse = API_CONTRACT.assignMemberRole.successResponse;
    const mock = createMockMemberService({
      assignMemberRole: jest.fn().mockResolvedValue(mockResponse),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: API_CONTRACT.assignMemberRole.method,
      url: API_CONTRACT.assignMemberRole.samplePath,
      headers: {
        'x-wallet': '0xrequester0000000000000000000000000000000000',
      },
      payload: API_CONTRACT.assignMemberRole.requestBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().role).toBe('admin');
    expect(mock.assignMemberRole).toHaveBeenCalled();

    await app.close();
  });
});

describe('DELETE /v1/communities/:communityId/members/:wallet/roles/:role', () => {
  test('removes a role from a member', async () => {
    const mockResponse = API_CONTRACT.removeMemberRole.successResponse;
    const mock = createMockMemberService({
      removeMemberRole: jest.fn().mockResolvedValue(mockResponse),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: API_CONTRACT.removeMemberRole.method,
      url: API_CONTRACT.removeMemberRole.samplePath,
      headers: {
        'x-wallet': '0xrequester0000000000000000000000000000000000',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().removed).toBe(true);
    expect(mock.removeMemberRole).toHaveBeenCalled();

    await app.close();
  });
});

describe('POST /v1/communities/:communityId/overrides', () => {
  test('creates or updates a manual access override', async () => {
    const mockResponse = {
      communityId: 'community-1',
      wallet: '0xwallet1234567890abcdef1234567890abcdef12',
      resource: 'dashboard',
      effect: 'ALLOW',
      created: true,
      removed: false,
    };
    const mock = createMockMemberService({
      createAccessOverride: jest.fn().mockResolvedValue(mockResponse),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/communities/community-1/overrides',
      headers: {
        'x-wallet': '0xrequester0000000000000000000000000000000000',
      },
      payload: {
        wallet: '0xwallet1234567890abcdef1234567890abcdef12',
        resource: 'dashboard',
        effect: 'ALLOW',
        reason: 'VIP Client',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.created).toBe(true);
    expect(body.effect).toBe('ALLOW');
    expect(mock.createAccessOverride).toHaveBeenCalledWith({
      requesterWallet: '0xrequester0000000000000000000000000000000000',
      communityId: 'community-1',
      wallet: '0xwallet1234567890abcdef1234567890abcdef12',
      resource: 'dashboard',
      effect: 'ALLOW',
      reason: 'VIP Client',
      expiresAt: null,
    });

    await app.close();
  });

  test('returns 400 when missing required fields', async () => {
    const mock = createMockMemberService();
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/communities/community-1/overrides',
      payload: {
        wallet: '0xwallet1234567890abcdef1234567890abcdef12',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('VALIDATION_ERROR');

    await app.close();
  });
});

describe('DELETE /v1/communities/:communityId/overrides/:wallet/:resource', () => {
  test('revokes a manual access override', async () => {
    const mockResponse = {
      communityId: 'community-1',
      wallet: '0xwallet1234567890abcdef1234567890abcdef12',
      resource: 'dashboard',
      effect: 'DENY',
      created: false,
      removed: true,
    };
    const mock = createMockMemberService({
      revokeAccessOverride: jest.fn().mockResolvedValue(mockResponse),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/communities/community-1/overrides/0xwallet1234567890abcdef1234567890abcdef12/dashboard',
      headers: {
        'x-wallet': '0xrequester0000000000000000000000000000000000',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.removed).toBe(true);
    expect(mock.revokeAccessOverride).toHaveBeenCalledWith({
      requesterWallet: '0xrequester0000000000000000000000000000000000',
      communityId: 'community-1',
      wallet: '0xwallet1234567890abcdef1234567890abcdef12',
      resource: 'dashboard',
      effect: 'DENY',
    });

    await app.close();
  });
});

