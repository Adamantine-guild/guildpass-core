import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Fastify route integration tests using app.inject().
 *
 * These tests create a Fastify instance with mocked services —
 * no network binding, no Prisma, no workspace deps required.
 */

type MembershipState = 'active' | 'expired' | 'suspended' | 'invited';

// --- Mock service factory ---
function createMockMemberService(overrides: Record<string, jest.Mock> = {}) {
  return {
    getMembershipsByWallet: overrides.getMembershipsByWallet ?? jest.fn(),
    getProfileByWallet: overrides.getProfileByWallet ?? jest.fn(),
    checkAccess: overrides.checkAccess ?? jest.fn(),
    listMembersForAdmin: overrides.listMembersForAdmin ?? jest.fn(),
  };
}

// --- Build test app with mocked services ---
async function buildTestApp(mockService: ReturnType<typeof createMockMemberService>): Promise<FastifyInstance> {
  const app = Fastify();

  // Health route
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register routes with mocked service
  app.get('/v1/memberships/:wallet', async (request) => {
    const { wallet } = request.params as { wallet: string };
    return mockService.getMembershipsByWallet(wallet);
  });

  app.get('/v1/members/:wallet', async (request, reply) => {
    const { wallet } = request.params as { wallet: string };
    const result = await mockService.getProfileByWallet(wallet);
    if (!result) {
      return reply.status(404).send({ error: 'Member not found' });
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
      return reply.status(400).send({
        error: 'Missing required fields: wallet, communityId, resource',
      });
    }
    return mockService.checkAccess(body);
  });

  app.get('/v1/communities/:communityId/members', async (request) => {
    const { communityId } = request.params as { communityId: string };
    const role = (request.query as { role?: string })?.role;
    return mockService.listMembersForAdmin(communityId, role);
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
    const mockData = {
      wallet: '0x1234567890abcdef1234567890abcdef12345678',
      communities: [
        { communityId: 'community-1', state: 'active', expiresAt: null },
      ],
    };
    const mock = createMockMemberService({
      getMembershipsByWallet: jest.fn().mockResolvedValue(mockData),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/memberships/0x1234567890abcdef1234567890abcdef12345678',
    });

    expect(response.statusCode).toBe(200);
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
      url: '/v1/memberships/0x0000000000000000000000000000000000000000',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().communities).toEqual([]);

    await app.close();
  });
});

describe('GET /v1/members/:wallet', () => {
  test('returns 200 with profile for found member', async () => {
    const mockData = {
      communityId: 'community-1',
      profile: { id: 'p1', displayName: 'Alice', bio: 'Hello' },
      membership: { state: 'active', expiresAt: null },
      roles: ['admin'],
    };
    const mock = createMockMemberService({
      getProfileByWallet: jest.fn().mockResolvedValue(mockData),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/members/0x1234567890abcdef1234567890abcdef12345678',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.profile.displayName).toBe('Alice');
    expect(body.roles).toEqual(['admin']);

    await app.close();
  });

  test('returns 404 when member not found', async () => {
    const mock = createMockMemberService({
      getProfileByWallet: jest.fn().mockResolvedValue(null),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/members/0x0000000000000000000000000000000000000000',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('Member not found');

    await app.close();
  });
});

describe('POST /v1/access/check', () => {
  test('returns allowed=true when access is granted', async () => {
    const mockResult = {
      allowed: true,
      code: 'ALLOW',
      membershipState: 'active',
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

  test('returns 400 when required fields are missing', async () => {
    const mock = createMockMemberService();
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/access/check',
      payload: { wallet: '0x1234' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Missing required fields/);

    await app.close();
  });
});

describe('GET /v1/communities/:communityId/members', () => {
  test('returns member list for a community', async () => {
    const mockData = {
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
    };
    const mock = createMockMemberService({
      listMembersForAdmin: jest.fn().mockResolvedValue(mockData),
    });
    const app = await buildTestApp(mock);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/communities/community-1/members',
    });

    expect(response.statusCode).toBe(200);
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
      method: 'GET',
      url: '/v1/communities/community-1/members?role=admin',
    });

    expect(response.statusCode).toBe(200);
    expect(mock.listMembersForAdmin).toHaveBeenCalledWith('community-1', 'admin');

    await app.close();
  });
});
