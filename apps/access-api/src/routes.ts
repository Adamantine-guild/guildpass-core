import type { FastifyInstance } from 'fastify';
import { getPrisma } from './services/prisma';
import { getMemberService } from './services/memberService';
import type { AccessCheckInput, Role } from '@guildpass/shared-types';

// Route-level TypeScript interfaces matching JSON schemas
interface GetMembershipsParams {
  wallet: string;
}

interface GetMemberParams {
  wallet: string;
}

interface AccessCheckBody {
  wallet: string;
  communityId: string;
  resource: string;
}

interface ListMembersParams {
  communityId: string;
}

interface ListMembersQuery {
  role?: Role;
  limit?: string;
  cursor?: string;
}

export function registerRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const svc = getMemberService(prisma);

  app.get('/health', async () => ({ ok: true }));

  app.get<{ Params: GetMembershipsParams }>('/v1/memberships/:wallet', {
    schema: {
      summary: 'Fetch membership status for a wallet',
      params: { type: 'object', properties: { wallet: { type: 'string' } }, required: ['wallet'] },
      response: {
        200: {
          type: 'object',
          properties: {
            wallet: { type: 'string' },
            communities: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  communityId: { type: 'string' },
                  state: { type: 'string' },
                  expiresAt: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
      },
    },
  }, async (req) => {
    const wallet: string = req.params.wallet;
    return svc.getMembershipsByWallet(wallet);
  });

  app.get<{ Params: GetMemberParams }>('/v1/members/:wallet', {
    schema: {
      summary: 'Fetch a member profile by wallet',
      params: { type: 'object', properties: { wallet: { type: 'string' } }, required: ['wallet'] },
    },
  }, async (req, reply) => {
    const wallet: string = req.params.wallet;
    const profile = await svc.getProfileByWallet(wallet);
    if (!profile) return reply.code(404).send({ message: 'Not found' });
    return profile;
  });

  app.post<{ Body: AccessCheckBody }>('/v1/access/check', {
    schema: {
      summary: 'Perform an access check for a wallet, community, and resource',
      body: {
        type: 'object',
        properties: {
          wallet: { type: 'string' },
          communityId: { type: 'string' },
          resource: { type: 'string' }
        },
        required: ['wallet', 'communityId', 'resource']
      }
    }
  }, async (req) => {
    return svc.checkAccess(req.body as AccessCheckInput);
  });

  app.get<{ Params: ListMembersParams; Querystring: ListMembersQuery }>('/v1/communities/:communityId/members', {
    schema: {
      summary: 'List simple community member data for admins',
      params: { type: 'object', properties: { communityId: { type: 'string' } }, required: ['communityId'] },
      querystring: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          limit: { type: 'string' },
          cursor: { type: 'string' },
        },
      },
    }
  }, async (req) => {
    const communityId: string = req.params.communityId;
    const role = req.query.role as any;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const cursor = req.query.cursor as string | undefined;
    return svc.listMembersForAdmin(communityId, role, limit, cursor);
  });
}
