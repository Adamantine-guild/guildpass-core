import type { FastifyInstance } from 'fastify';
import { getMemberService } from './services/memberService';
import { getPrisma } from './services/prisma';

/**
 * Register all business routes on the Fastify instance.
 * Uses app.inject() friendly routes — no network binding required for tests.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const memberService = getMemberService(prisma);

  // GET /v1/memberships/:wallet — list membership communities for a wallet
  app.get('/v1/communities/:communityId/memberships/:wallet', async (request, reply) => {
    const { communityId, wallet } = request.params as { communityId: string; wallet: string };
    const result = await memberService.getMembershipsByWallet(wallet, communityId);
    return result;
  });

  // GET /v1/communities/:communityId/members/:wallet — get member profile
  app.get('/v1/communities/:communityId/members/:wallet', async (request, reply) => {
    const { communityId, wallet } = request.params as { communityId: string; wallet: string };
    const result = await memberService.getProfileByWallet(wallet, communityId);
    if (!result) {
      return reply.status(404).send({ error: 'Member not found' });
    }
    return result;
  });


  // POST /v1/access/check — check access for wallet/resource
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
    const result = await memberService.checkAccess(body);
    return result;
  });

  // GET /v1/communities/:communityId/members — list members for admin
  app.get('/v1/communities/:communityId/members', async (request, reply) => {
    const { communityId } = request.params as { communityId: string };
    const role = (request.query as { role?: string })?.role;
    const result = await memberService.listMembersForAdmin(communityId, role as "admin" | "member" | "contributor" | undefined);
    return result;
  });
}
