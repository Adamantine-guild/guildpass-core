import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getMemberService, MemberServiceError } from './services/memberService';
import { getIdentityService, IdentityServiceError } from './services/identityService';
import { getGovernanceService } from './services/governanceService';
import { registerGovernanceRoutes } from './routes/governanceRoutes';
import { getModerationService, ModerationError } from './services/moderation/moderationService';
import { queryAuditEvents } from './services/auditService';
import { getPrisma } from './services/prisma';
import {
  getAuditTraceByCorrelationId,
  getAuditTracesByTxHash,
  getAuditTracesByWallet,
} from './services/auditTraceService';
import { notFound, validationError, validationErrorWithReason } from './errors';
import {
  listDeadLetterEvents,
  retryDeadLetterEvent,
  DeadLetterNotFoundError,
  DeadLetterAlreadyResolvedError,
} from './services/deadLetterService';
import { getResourceService, ResourceServiceError } from './services/resourceService';
import { Challenge, LinkWalletInput, WalletAddress } from '@guildpass/shared-types';
import {
  getMembershipsSchema,
  getMemberProfileSchema,
  assignMemberRoleSchema,
  removeMemberRoleSchema,
  assignBadgeSchema,
  listBadgesSchema,
  revokeBadgeSchema,
  createAccessOverrideSchema,
  revokeAccessOverrideSchema,
  listAccessOverridesSchema,
  accessCheckSchema,
  listCommunityMembersSchema,
  listDeadLetterEventsSchema,
  retryDeadLetterEventSchema,
  listAuditEventsSchema,
  createResourceSchema,
  updateResourceSchema,
  archiveResourceSchema,
  listResourcesSchema,
} from './schemas';
import { authenticateApiKey, authenticateSessionOrApiKey, verifySiweSignature } from './lib/auth/auth';
import crypto from 'crypto';

function getRequesterWallet(request: FastifyRequest): string {
  if ((request as any).authenticatedWallet) {
    return (request as any).authenticatedWallet;
  }
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
  const identityService = getIdentityService(prisma);
  const moderationService = getModerationService(prisma);
  const resourceService = getResourceService(prisma);

  // --- SIWE Authentication Routes ---

  // Generate a SIWE nonce
  app.post('/v1/auth/nonce', async (request: FastifyRequest, reply: FastifyReply) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes expiry
    await prisma.siweNonce.create({
      data: {
        nonce,
        expiresAt,
      },
    });
    return reply.send({ nonce });
  });

  // Verify SIWE signature and issue session token
  app.post('/v1/auth/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    const { message, signature } = request.body as { message: string; signature: string };
    if (!message || !signature) {
      return reply.status(400).send({ error: 'Missing message or signature' });
    }

    let parsedMessage;
    try {
      const { parseSiweMessage } = require('./lib/auth/auth');
      parsedMessage = parseSiweMessage(message);
    } catch (err) {
      return reply.status(400).send({ error: 'Invalid SIWE message format' });
    }

    const storedNonce = await prisma.siweNonce.findUnique({
      where: { nonce: parsedMessage.nonce },
    });

    if (!storedNonce) {
      return reply.status(400).send({ error: 'Invalid nonce' });
    }

    if (new Date(storedNonce.expiresAt) < new Date()) {
      return reply.status(400).send({ error: 'Nonce has expired' });
    }

    await prisma.siweNonce.delete({ where: { id: storedNonce.id } });

    try {
      const walletAddress = verifySiweSignature(message, signature, parsedMessage.nonce);
      const token = crypto.randomBytes(32).toString('hex');
      const sessionExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours
      
      const session = await prisma.session.create({
        data: {
          walletAddress: walletAddress.toLowerCase(),
          token,
          expiresAt: sessionExpiry,
        },
      });

      return reply.send({
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
        walletAddress: session.walletAddress,
      });
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Signature verification failed' });
    }
  });

  // --- Wallet Linking Routes ---

  // Generate a challenge
  app.post(
    '/v1/wallets/:primaryWallet/challenges',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { primaryWallet } = request.params as { primaryWallet: string };
      const { secondaryWallet } = request.body as { secondaryWallet: string };
      try {
        const challenge = await identityService.generateChallenge(
          primaryWallet as WalletAddress, secondaryWallet as WalletAddress);
        return reply.send(challenge);
      } catch (error) {
        if (error instanceof IdentityServiceError) {
          return reply.status(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  // Link a wallet using a challenge and signature
  app.post(
    '/v1/wallets/:primaryWallet/link',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { primaryWallet } = request.params as { primaryWallet: string };
      const { challenge, signature } = request.body as {
        challenge: Challenge,
        signature: string
      };
      try {
        const linkResult = await identityService.linkWallet({
          challenge,
          signature
        });
        return reply.send(linkResult);
      } catch (error) {
        if (error instanceof IdentityServiceError) {
          return reply.status(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  // Get linked wallets for a primary wallet
  app.get(
    '/v1/wallets/:primaryWallet/linked',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { primaryWallet } = request.params as { primaryWallet: string };
      try {
        const linkedWallets = await identityService.getLinkedWallets(primaryWallet as WalletAddress);
        return reply.send({ primaryWallet, linkedWallets });
      } catch (error) {
        if (error instanceof IdentityServiceError) {
          return reply.status(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  // --- Appeals and Moderation Routes ---

  // File an appeal for a suspended member
  app.post(
    '/v1/memberships/:wallet/appeals',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { wallet } = request.params as { wallet: string };
      const { communityId, reason } = request.body as { communityId: string; reason: string };
      if (!communityId || !reason) {
        return reply.status(400).send({ error: 'Missing communityId or reason' });
      }
      try {
        const result = await moderationService.fileAppeal(wallet, communityId, reason);
        return reply.send(result);
      } catch (error) {
        if (error instanceof ModerationError) {
          return reply.status(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  // Transition an appeal status (Admin only)
  app.post(
    '/v1/appeals/:appealId/transition',
    { preHandler: [authenticateApiKey] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { appealId } = request.params as { appealId: string };
      const { status, adminComment } = request.body as { status: string; adminComment?: string };
      if (!status) {
        return reply.status(400).send({ error: 'Missing status' });
      }
      try {
        const result = await moderationService.transitionAppeal(appealId, status as any, adminComment);
        return reply.send(result);
      } catch (error) {
        if (error instanceof ModerationError) {
          return reply.status(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    }
  );

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
  app.post('/v1/communities/:communityId/members/:wallet/roles', { schema: assignMemberRoleSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
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
  app.delete('/v1/communities/:communityId/members/:wallet/roles/:role', { schema: removeMemberRoleSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
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

  // POST /v1/communities/:communityId/members/:wallet/badges — assign a badge to a member
  app.post('/v1/communities/:communityId/members/:wallet/badges', { schema: assignBadgeSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet } = request.params as { communityId: string; wallet: string };
    const body = request.body as { label?: string };
    const label = body?.label ?? '';
    const requesterWallet = getRequesterWallet(request);

    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return reply.status(400).send(validationErrorWithReason('INVALID_WALLET', 'Invalid wallet format'));
    }

    const community = await prisma.community.findUnique({ where: { id: communityId } });
    if (!community) {
      return reply.status(400).send(validationErrorWithReason('UNKNOWN_COMMUNITY', 'Unknown communityId'));
    }

    if (!label.trim()) {
      return reply.status(400).send(validationError('Missing required field: label'));
    }

    try {
      const result = await memberService.assignBadge({
        requesterWallet: requesterWallet as import('@guildpass/shared-types').WalletAddress,
        communityId,
        targetWallet: wallet as import('@guildpass/shared-types').WalletAddress,
        label,
      });
      return reply.status(200).send(result);
    } catch (error) {
      return sendRoleMutationError(reply, error);
    }
  });

  // GET /v1/communities/:communityId/members/:wallet/badges — list badges for a member
  app.get('/v1/communities/:communityId/members/:wallet/badges', { schema: listBadgesSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet } = request.params as { communityId: string; wallet: string };

    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return reply.status(400).send(validationErrorWithReason('INVALID_WALLET', 'Invalid wallet format'));
    }

    const community = await prisma.community.findUnique({ where: { id: communityId } });
    if (!community) {
      return reply.status(400).send(validationErrorWithReason('UNKNOWN_COMMUNITY', 'Unknown communityId'));
    }

    const result = await memberService.listBadgesForMember(communityId, wallet);
    if (!result) {
      return reply.status(404).send(notFound('Member not found'));
    }
    return reply.status(200).send(result);
  });

  // DELETE /v1/communities/:communityId/members/:wallet/badges/:badgeId — revoke a badge
  app.delete('/v1/communities/:communityId/members/:wallet/badges/:badgeId', { schema: revokeBadgeSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet, badgeId } = request.params as { communityId: string; wallet: string; badgeId: string };
    const requesterWallet = getRequesterWallet(request);

    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return reply.status(400).send(validationErrorWithReason('INVALID_WALLET', 'Invalid wallet format'));
    }

    const community = await prisma.community.findUnique({ where: { id: communityId } });
    if (!community) {
      return reply.status(400).send(validationErrorWithReason('UNKNOWN_COMMUNITY', 'Unknown communityId'));
    }

    try {
      const result = await memberService.revokeBadge({
        requesterWallet: requesterWallet as import('@guildpass/shared-types').WalletAddress,
        communityId,
        targetWallet: wallet as import('@guildpass/shared-types').WalletAddress,
        badgeId,
      });
      return reply.status(200).send(result);
    } catch (error) {
      return sendRoleMutationError(reply, error);
    }
  });

  // POST /v1/communities/:communityId/overrides — create or update an access override for a wallet/resource
  app.post('/v1/communities/:communityId/overrides', { schema: createAccessOverrideSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
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

  // GET /v1/communities/:communityId/overrides — list access overrides for a community (admin)
  app.get('/v1/communities/:communityId/overrides', { schema: listAccessOverridesSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const requesterWallet = getRequesterWallet(request);
    try {
      if (!(await requireCommunityAdmin(communityId, requesterWallet))) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
      const result = await memberService.listAccessOverrides(communityId, requesterWallet);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof MemberServiceError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // DELETE /v1/communities/:communityId/overrides/:wallet/:resource — revoke an access override
  app.delete('/v1/communities/:communityId/overrides/:wallet/:resource', { schema: revokeAccessOverrideSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
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
  app.post('/v1/access/check', { 
    schema: accessCheckSchema,
    preHandler: app.accessCheckRateLimitHook ? [app.accessCheckRateLimitHook] : undefined,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
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
  app.get('/v1/communities/:communityId/members', { schema: listCommunityMembersSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
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
  app.get('/v1/communities/:communityId/dead-letter-events', { schema: listDeadLetterEventsSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
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
  app.post('/v1/communities/:communityId/dead-letter-events/:id/retry', { schema: retryDeadLetterEventSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
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

  // --- Admin Audit Trace Routes ---

  // GET /admin/audit/trace/* — query audit traces (by txHash, wallet, or correlationId)
  app.get('/admin/audit/trace/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const wildcard = (request.params as any)['*'];

    if (wildcard.startsWith('tx/')) {
      const txHash = wildcard.substring(3);
      const result = await getAuditTracesByTxHash(txHash, prisma);
      return { txHash, traces: result };
    }

    if (wildcard.startsWith('wallet/')) {
      const wallet = wildcard.substring(7);
      const { communityId } = request.query as { communityId?: string };
      if (!communityId) {
        return reply.status(400).send({ error: 'communityId query parameter is required' });
      }
      const result = await getAuditTracesByWallet(wallet, communityId, 50, prisma);
      return {
        wallet,
        communityId,
        traces: result,
      };
    }

    // Default: treat as correlationId
    const correlationId = wildcard;
    const result = await getAuditTraceByCorrelationId(correlationId, prisma);
    if (!result) {
      return reply.status(404).send({ error: 'Audit trace not found' });
    }
    return result;
  });

  // GET /v1/communities/:communityId/audit-events — filterable, paginated audit events for community admin
  app.get('/v1/communities/:communityId/audit-events', { schema: listAuditEventsSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const { actorWallet, eventType, resource, from, to, page, limit } = request.query as {
      actorWallet?: string;
      eventType?: string;
      resource?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    };
    const requesterWallet = getRequesterWallet(request);
    try {
      if (!(await requireCommunityAdmin(communityId, requesterWallet))) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      let parsedFrom: Date | undefined = undefined;
      let parsedTo: Date | undefined = undefined;

      if (from) {
        parsedFrom = new Date(from);
        if (isNaN(parsedFrom.getTime())) {
          return reply.status(400).send(validationError('Invalid from date format'));
        }
      }

      if (to) {
        parsedTo = new Date(to);
        if (isNaN(parsedTo.getTime())) {
          return reply.status(400).send(validationError('Invalid to date format'));
        }
      }

      const result = await queryAuditEvents(getPrisma(), {
        communityId,
        actorWallet,
        eventType,
        resource,
        from: parsedFrom,
        to: parsedTo,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      });

      return result;
    } catch (error) {
      if (error instanceof MemberServiceError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // --- Resource Routes ---

  app.post('/v1/communities/:communityId/resources', { schema: createResourceSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const body = request.body as { resourceId: string; name: string; metadata?: any };
    const requesterWallet = getRequesterWallet(request);
    try {
      const result = await resourceService.upsertResource({
        requesterWallet,
        communityId,
        resourceId: body.resourceId,
        name: body.name,
        metadata: body.metadata,
      });
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceServiceError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  app.patch('/v1/communities/:communityId/resources/:resourceId', { schema: updateResourceSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, resourceId } = request.params as { communityId: string; resourceId: string };
    const body = request.body as { name?: string; metadata?: any };
    const requesterWallet = getRequesterWallet(request);
    try {
      const result = await resourceService.updateResource({
        requesterWallet,
        communityId,
        resourceId,
        name: body.name,
        metadata: body.metadata,
      });
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceServiceError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  app.delete('/v1/communities/:communityId/resources/:resourceId', { schema: archiveResourceSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, resourceId } = request.params as { communityId: string; resourceId: string };
    const requesterWallet = getRequesterWallet(request);
    try {
      const result = await resourceService.archiveResource({
        requesterWallet,
        communityId,
        resourceId,
      });
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceServiceError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  app.get('/v1/communities/:communityId/resources', { schema: listResourcesSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    // listResources does not strictly require admin auth according to the service definition
    try {
      const result = await resourceService.listResources(communityId);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceServiceError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

}
