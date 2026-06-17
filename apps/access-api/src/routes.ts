import type { FastifyInstance } from 'fastify';
import { getPrisma } from './services/prisma';
import { getMemberService } from './services/memberService';
import {
  accessCheckBodySchema,
  communityIdParamSchema,
  parseBody,
  parseParams,
  parseQuery,
  roleQuerySchema,
  walletParamSchema,
} from './validators';

export function registerRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const svc = getMemberService(prisma);

  app.get('/health', async () => ({ ok: true }));

  app.get('/v1/memberships/:wallet', {
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
  }, async (req, reply) => {
    const params = parseParams(req, reply, walletParamSchema);
    if (!params) return;
    return svc.getMembershipsByWallet(params.wallet);
  });

  app.get('/v1/members/:wallet', {
    schema: {
      summary: 'Fetch a member profile by wallet',
      params: { type: 'object', properties: { wallet: { type: 'string' } }, required: ['wallet'] },
    },
  }, async (req, reply) => {
    const params = parseParams(req, reply, walletParamSchema);
    if (!params) return;
    const profile = await svc.getProfileByWallet(params.wallet);
    if (!profile) return reply.code(404).send({ message: 'Not found' });
    return profile;
  });

  app.post('/v1/access/check', {
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
  }, async (req, reply) => {
    const body = parseBody(req, reply, accessCheckBodySchema);
    if (!body) return;
    return svc.checkAccess(body);
  });

  app.get('/v1/communities/:communityId/members', {
    schema: {
      summary: 'List simple community member data for admins',
      params: { type: 'object', properties: { communityId: { type: 'string' } }, required: ['communityId'] },
      querystring: { type: 'object', properties: { role: { type: 'string' } } }
    }
  }, async (req, reply) => {
    const params = parseParams(req, reply, communityIdParamSchema);
    if (!params) return;
    const query = parseQuery(req, reply, roleQuerySchema);
    if (!query) return;
    return svc.listMembersForAdmin(params.communityId, query.role);
  });
}
