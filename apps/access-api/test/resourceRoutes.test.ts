import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../src/routes';
import { getPrisma } from '../src/services/prisma';

jest.mock('../src/services/prisma', () => {
  const mPrisma = {
    wallet: {
      findUnique: jest.fn(),
    },
    member: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    community: {
      findUnique: jest.fn().mockResolvedValue({ id: 'community-1' }),
    },
    resource: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    outboxEvent: {
      create: jest.fn(),
    },
    $transaction: jest.fn().mockImplementation(async (cb) => {
      return cb(mPrisma);
    }),
  };
  return {
    getPrisma: () => mPrisma,
  };
});

describe('Resource Routes Integration Tests', () => {
  let app: FastifyInstance;
  let prisma: any;

  beforeAll(async () => {
    app = Fastify();
    await registerRoutes(app);
    prisma = getPrisma();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Authorization Denials', () => {
    it('POST /v1/communities/:communityId/resources should deny non-admin', async () => {
      prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', address: '0x123' });
      prisma.member.findFirst.mockResolvedValue({ roles: [{ role: 'member', active: true }] });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/communities/community-1/resources',
        headers: {
          'x-wallet': '0x123',
        },
        payload: {
          resourceId: 'res-1',
          name: 'My Resource',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('PATCH /v1/communities/:communityId/resources/:resourceId should deny non-admin', async () => {
      prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', address: '0x123' });
      prisma.member.findFirst.mockResolvedValue({ roles: [{ role: 'member', active: true }] });

      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/communities/community-1/resources/res-1',
        headers: {
          'x-wallet': '0x123',
        },
        payload: {
          name: 'Updated Resource',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('DELETE /v1/communities/:communityId/resources/:resourceId should deny non-admin', async () => {
      prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', address: '0x123' });
      prisma.member.findFirst.mockResolvedValue({ roles: [{ role: 'member', active: true }] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/communities/community-1/resources/res-1',
        headers: {
          'x-wallet': '0x123',
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('Success Paths', () => {
    beforeEach(() => {
      prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', address: '0xadmin' });
      prisma.member.findFirst.mockResolvedValue({ roles: [{ role: 'admin', active: true }] });
    });

    it('GET /v1/communities/:communityId/resources should list resources', async () => {
      prisma.resource.findMany.mockResolvedValue([
        { resourceId: 'res-1', name: 'Resource 1', metadata: null, archived: false },
        { resourceId: 'res-2', name: 'Resource 2', metadata: {}, archived: true },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/communities/community-1/resources',
        headers: {
          'x-wallet': '0xany',
        },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.communityId).toBe('community-1');
      expect(json.resources).toHaveLength(2);
      expect(json.resources[0].resourceId).toBe('res-1');
    });

    it('POST /v1/communities/:communityId/resources should create a resource', async () => {
      prisma.resource.findUnique.mockResolvedValue(null); // not existing
      prisma.resource.create.mockResolvedValue({
        communityId: 'community-1',
        resourceId: 'new-res',
        name: 'New Resource',
        metadata: { a: 1 },
        archived: false,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/communities/community-1/resources',
        headers: {
          'x-wallet': '0xadmin',
        },
        payload: {
          resourceId: 'new-res',
          name: 'New Resource',
          metadata: { a: 1 },
        },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.created).toBe(true);
      expect(json.resourceId).toBe('new-res');
    });

    it('PATCH /v1/communities/:communityId/resources/:resourceId should update a resource', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        communityId: 'community-1',
        resourceId: 'res-1',
        name: 'Old Resource',
      });
      prisma.resource.update.mockResolvedValue({
        communityId: 'community-1',
        resourceId: 'res-1',
        name: 'Updated Resource',
        metadata: null,
        archived: false,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/communities/community-1/resources/res-1',
        headers: {
          'x-wallet': '0xadmin',
        },
        payload: {
          name: 'Updated Resource',
        },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.name).toBe('Updated Resource');
    });

    it('DELETE /v1/communities/:communityId/resources/:resourceId should archive a resource', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        communityId: 'community-1',
        resourceId: 'res-1',
      });
      prisma.resource.update.mockResolvedValue({
        communityId: 'community-1',
        resourceId: 'res-1',
        archived: true,
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/communities/community-1/resources/res-1',
        headers: {
          'x-wallet': '0xadmin',
        },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.archived).toBe(true);
    });
  });
});
