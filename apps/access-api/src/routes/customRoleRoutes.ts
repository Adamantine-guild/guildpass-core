import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CustomRoleService,
  CustomRoleServiceError,
  type CustomRoleInput,
} from '../services/customRoleService';

export interface CustomRoleRoutesDeps {
  service: CustomRoleService;
  requireCommunityAdmin: (communityId: string, wallet: string) => Promise<boolean>;
  getRequesterWallet: (request: FastifyRequest) => string;
}

const roleBodySchema = {
  type: 'object',
  required: ['name', 'permissions'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 64 },
    description: { type: ['string', 'null'] },
    parentRoleId: { type: ['string', 'null'] },
    permissions: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)+$' },
    },
  },
} as const;

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof CustomRoleServiceError) {
    return reply.status(error.statusCode).send({ error: error.message });
  }
  if ((error as { code?: string }).code === 'P2002') {
    return reply.status(409).send({ error: 'A custom role with that name already exists' });
  }
  throw error;
}

export function registerCustomRoleRoutes(app: FastifyInstance, deps: CustomRoleRoutesDeps): void {
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    if (!await deps.requireCommunityAdmin(communityId, deps.getRequesterWallet(request))) {
      reply.status(403).send({ error: 'Forbidden' });
      return false;
    }
    return true;
  };

  app.post('/v1/communities/:communityId/role-definitions', {
    schema: { body: roleBodySchema },
  }, async (request, reply) => {
    if (!await authorize(request, reply)) return;
    const { communityId } = request.params as { communityId: string };
    try {
      return reply.status(201).send(await deps.service.create(
        communityId,
        request.body as CustomRoleInput,
      ));
    } catch (error) { return sendError(reply, error); }
  });

  app.get('/v1/communities/:communityId/role-definitions', async (request, reply) => {
    if (!await authorize(request, reply)) return;
    const { communityId } = request.params as { communityId: string };
    return { roles: await deps.service.list(communityId) };
  });

  app.put('/v1/communities/:communityId/role-definitions/:roleId', {
    schema: { body: roleBodySchema },
  }, async (request, reply) => {
    if (!await authorize(request, reply)) return;
    const { communityId, roleId } = request.params as { communityId: string; roleId: string };
    try {
      return await deps.service.update(communityId, roleId, request.body as CustomRoleInput);
    } catch (error) { return sendError(reply, error); }
  });

  app.delete('/v1/communities/:communityId/role-definitions/:roleId', async (request, reply) => {
    if (!await authorize(request, reply)) return;
    const { communityId, roleId } = request.params as { communityId: string; roleId: string };
    try {
      await deps.service.remove(communityId, roleId);
      return reply.status(204).send();
    } catch (error) { return sendError(reply, error); }
  });

  app.put('/v1/communities/:communityId/members/:wallet/custom-roles/:roleId',
    async (request, reply) => {
      if (!await authorize(request, reply)) return;
      const { communityId, roleId, wallet } = request.params as {
        communityId: string; roleId: string; wallet: string;
      };
      try {
        return await deps.service.assign(communityId, roleId, wallet);
      } catch (error) { return sendError(reply, error); }
    });

  app.delete('/v1/communities/:communityId/members/:wallet/custom-roles/:roleId',
    async (request, reply) => {
      if (!await authorize(request, reply)) return;
      const { communityId, roleId, wallet } = request.params as {
        communityId: string; roleId: string; wallet: string;
      };
      try {
        await deps.service.unassign(communityId, roleId, wallet);
        return reply.status(204).send();
      } catch (error) { return sendError(reply, error); }
    });
}
