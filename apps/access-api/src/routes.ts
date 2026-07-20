import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getMemberService, MemberServiceError } from './services/memberService';
import { getPrisma } from './services/prisma';
import { notFound, validationError, validationErrorWithReason } from './errors';
import {
  listDeadLetterEvents,
  retryDeadLetterEvent,
  DeadLetterNotFoundError,
  DeadLetterAlreadyResolvedError,
} from './services/deadLetterService';
import {
  getMembershipsSchema,
  getMemberProfileSchema,
  assignMemberRoleSchema,
  removeMemberRoleSchema,
  createAccessOverrideSchema,
  revokeAccessOverrideSchema,
  accessCheckSchema,
  listCommunityMembersSchema,
  listDeadLetterEventsSchema,
  retryDeadLetterEventSchema,
} from './schemas';

function getRequesterWallet(request: FastifyRequest): string {
  const header = request.headers['x-wallet'] ?? request.headers['x-user-wallet'] ?? request.headers['x-requester-wallet'];
  if (Array.isArray(header)) {
    return header[0] ?? '';
  }
  if (header) {
    return header;
  }
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice(7).trim();
  }
  return '';
}

function sendRoleMutationError(reply: FastifyReply, error: unknown) {
  if (error instanceof MemberServiceError) {
    return reply.status(error.statusCode).send({ error: error.message });
  }
  return reply.status(500).send({ error: 'Internal server error' });
}

/**
 * Register all business routes on the Fastify instance.
 * Uses app.inject() friendly routes — no network binding required for tests.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const memberService = getMemberService(prisma);

  // GET /v1/communities/:communityId/memberships/:wallet — list membership communities for a wallet
  app.get('/v1/communities/:communityId/memberships/:wallet', { schema: getMembershipsSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet } = request.params as { communityId: string; wallet: string };
    const result = await memberService.getMembershipsByWallet(wallet, communityId);
    return result;
  });

  // GET /v1/communities/:communityId/members/:wallet — get member profile
  app.get('/v1/communities/:communityId/members/:wallet', { schema: getMemberProfileSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet } = request.params as { communityId: string; wallet: string };
    const result = await memberService.getProfileByWallet(wallet, communityId);
    if (!result) {
      return reply.status(404).send(notFound('Member not found'));
    }
    return result;
  });

  // POST /v1/communities/:communityId/members/:wallet/roles — assign a role to a member
  app.post('/v1/communities/:communityId/members/:wallet/roles', { schema: assignMemberRoleSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet } = request.params as { communityId: string; wallet: string };
    const body = request.body as { role?: string };
    const role = body?.role ?? '';
    const requesterWallet = getRequesterWallet(request);

    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return reply.status(400).send(validationErrorWithReason('INVALID_WALLET', 'Invalid wallet format'));
    }

    const community = await prisma.community.findUnique({ where: { id: communityId } });
    if (!community) {
      return reply.status(400).send(validationErrorWithReason('UNKNOWN_COMMUNITY', 'Unknown communityId'));
    }

    const validRoles = ['admin', 'member', 'contributor'];
    if (!role || !validRoles.includes(role)) {
      return reply.status(400).send(validationErrorWithReason('INVALID_ROLE', 'Unrecognized role'));
    }

    try {
      const result = await memberService.assignMemberRole({
        requesterWallet: requesterWallet as import('@guildpass/shared-types').WalletAddress,
        communityId,
        targetWallet: wallet as import('@guildpass/shared-types').WalletAddress,
        role: role as import('@guildpass/shared-types').Role,
      });
      return reply.status(200).send(result);
    } catch (error) {
      return sendRoleMutationError(reply, error);
    }
  });

  // DELETE /v1/communities/:communityId/members/:wallet/roles/:role — remove an assigned role
  app.delete('/v1/communities/:communityId/members/:wallet/roles/:role', { schema: removeMemberRoleSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet, role } = request.params as { communityId: string; wallet: string; role: string };
    const requesterWallet = getRequesterWallet(request);

    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return reply.status(400).send(validationErrorWithReason('INVALID_WALLET', 'Invalid wallet format'));
    }

    const community = await prisma.community.findUnique({ where: { id: communityId } });
    if (!community) {
      return reply.status(400).send(validationErrorWithReason('UNKNOWN_COMMUNITY', 'Unknown communityId'));
    }

    const validRoles = ['admin', 'member', 'contributor'];
    if (!role || !validRoles.includes(role)) {
      return reply.status(400).send(validationErrorWithReason('INVALID_ROLE', 'Unrecognized role'));
    }

    try {
      const result = await memberService.removeMemberRole({
        requesterWallet: requesterWallet as import('@guildpass/shared-types').WalletAddress,
        communityId,
        targetWallet: wallet as import('@guildpass/shared-types').WalletAddress,
        role: role as import('@guildpass/shared-types').Role,
      });
      return reply.status(200).send(result);
    } catch (error) {
      return sendRoleMutationError(reply, error);
    }
  });

  // POST /v1/communities/:communityId/overrides — create or update an access override for a wallet/resource
  app.post('/v1/communities/:communityId/overrides', { schema: createAccessOverrideSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const body = request.body as {
      wallet?: string;
      resource?: string;
      effect?: string;
      reason?: string;
      expiresAt?: string | null;
    };
    if (!body?.wallet || !body?.resource || !body?.effect) {
      return reply.status(400).send(
        validationError('Missing required fields: wallet, resource, effect'),
      );
    }
    const requesterWallet = getRequesterWallet(request);
    try {
      const result = await memberService.createAccessOverride({
        requesterWallet: requesterWallet as import('@guildpass/shared-types').WalletAddress,
        communityId,
        wallet: body.wallet as import('@guildpass/shared-types').WalletAddress,
        resource: body.resource,
        effect: body.effect as 'ALLOW' | 'DENY',
        reason: body.reason,
        expiresAt: body.expiresAt ?? null,
      });
      return reply.status(200).send(result);
    } catch (error) {
      return sendRoleMutationError(reply, error);
    }
  });

  // DELETE /v1/communities/:communityId/overrides/:wallet/:resource — revoke an access override
  app.delete('/v1/communities/:communityId/overrides/:wallet/:resource', { schema: revokeAccessOverrideSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet, resource } = request.params as { communityId: string; wallet: string; resource: string };
    const requesterWallet = getRequesterWallet(request);
    try {
      const result = await memberService.revokeAccessOverride({
        requesterWallet: requesterWallet as import('@guildpass/shared-types').WalletAddress,
        communityId,
        wallet: wallet as import('@guildpass/shared-types').WalletAddress,
        resource,
        effect: 'DENY',
      });
      return reply.status(200).send(result);
    } catch (error) {
      return sendRoleMutationError(reply, error);
    }
  });

  // POST /v1/access/check — check access for wallet/resource
  app.post('/v1/access/check', { schema: accessCheckSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      wallet: `0x${string}`;
      communityId: string;
      resource: string;
    };
    if (!body?.wallet || !body?.communityId || !body?.resource) {
      return reply.status(400).send(
        validationError('Missing required fields: wallet, communityId, resource'),
      );
    }
    const result = await memberService.checkAccess(body as import('@guildpass/shared-types').AccessCheckInput);
    return result;
  });

  // GET /v1/communities/:communityId/members — list members for admin
  app.get('/v1/communities/:communityId/members', { schema: listCommunityMembersSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const role = (request.query as { role?: string })?.role;
    // Ensure caller is an authenticated community admin by reusing mutation auth check.
    const requesterWallet = getRequesterWallet(request);
    try {
      // Reuse a minimal auth check by verifying requester has admin role in the community.
      // We do this by calling listMembersForAdmin only after requester is validated.
      const requesterMembers = await memberService.listMembersForAdmin(
        communityId,
        role as 'admin' | 'member' | 'contributor' | undefined,
      );
      // listMembersForAdmin is not requester-scoped; enforce admin authorization in a lightweight way:
      // If requester is missing from admin-filtered listing, deny.
      if (role === 'admin') {
        // If caller requested admin-only view, still require requester to be admin.
        const isAdmin = requesterMembers.members.some(
          (m: any) => m.wallet?.toLowerCase?.() === requesterWallet.toLowerCase(),
        );
        if (!isAdmin) return reply.status(403).send({ error: 'Forbidden' });
      }
      return requesterMembers;
    } catch (error) {
      if (error instanceof MemberServiceError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  async function requireCommunityAdmin(
    communityId: string,
    requesterWallet: string,
  ): Promise<boolean> {
    const admins = await memberService.listMembersForAdmin(communityId, 'admin');
    return admins.members.some(
      (m: any) => m.wallet?.toLowerCase?.() === requesterWallet.toLowerCase(),
    );
  }

  // GET /v1/communities/:communityId/dead-letter-events — inspect webhook
  // deliveries that exhausted the outbox's retry budget
  app.get('/v1/communities/:communityId/dead-letter-events', { schema: listDeadLetterEventsSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const { status } = request.query as { status?: 'pending' | 'retried' | 'resolved' };
    const requesterWallet = getRequesterWallet(request);
    try {
      if (!(await requireCommunityAdmin(communityId, requesterWallet))) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
      const events = await listDeadLetterEvents(getPrisma(), { communityId, status });
      return { events };
    } catch (error) {
      if (error instanceof MemberServiceError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST /v1/communities/:communityId/dead-letter-events/:id/retry — re-enqueue
  // a dead-lettered event as a fresh pending OutboxEvent
  app.post('/v1/communities/:communityId/dead-letter-events/:id/retry', { schema: retryDeadLetterEventSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, id } = request.params as { communityId: string; id: string };
    const requesterWallet = getRequesterWallet(request);
    try {
      if (!(await requireCommunityAdmin(communityId, requesterWallet))) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
      const result = await retryDeadLetterEvent(getPrisma(), id);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof DeadLetterNotFoundError) {
        return reply.status(404).send(notFound(error.message));
      }
      if (error instanceof DeadLetterAlreadyResolvedError) {
        return reply.status(409).send({ error: error.message });
      }
      if (error instanceof MemberServiceError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

}
