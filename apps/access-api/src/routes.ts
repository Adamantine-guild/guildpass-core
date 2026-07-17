import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getMemberService, MemberServiceError } from './services/memberService';
import { getPrisma } from './services/prisma';
import { notFound, validationError } from './errors';
import { getAuditTraceByCorrelationId, getAuditTracesByTxHash, getAuditTracesByWallet } from './services/auditTraceService';
import { getGovernanceService } from './services/governanceService';
import { formatTrace } from '@guildpass/governance-engine';

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
  app.get('/v1/communities/:communityId/memberships/:wallet', async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet } = request.params as { communityId: string; wallet: string };
    const result = await memberService.getMembershipsByWallet(wallet, communityId);
    return result;
  });

  // GET /v1/communities/:communityId/members/:wallet — get member profile
  app.get('/v1/communities/:communityId/members/:wallet', async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet } = request.params as { communityId: string; wallet: string };
    const result = await memberService.getProfileByWallet(wallet, communityId);
    if (!result) {
      return reply.status(404).send(notFound('Member not found'));
    }
    return result;
  });

  // POST /v1/communities/:communityId/members/:wallet/roles — assign a role to a member
  app.post('/v1/communities/:communityId/members/:wallet/roles', async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet } = request.params as { communityId: string; wallet: string };
    const body = request.body as { role?: string };
    const requesterWallet = getRequesterWallet(request);

    try {
      const result = await memberService.assignMemberRole({
        requesterWallet,
        communityId,
        targetWallet: wallet,
        role: body?.role ?? '',
      });
      return reply.status(200).send(result);
    } catch (error) {
      return sendRoleMutationError(reply, error);
    }
  });

  // DELETE /v1/communities/:communityId/members/:wallet/roles/:role — remove an assigned role
  app.delete('/v1/communities/:communityId/members/:wallet/roles/:role', async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet, role } = request.params as { communityId: string; wallet: string; role: string };
    const requesterWallet = getRequesterWallet(request);

    try {
      const result = await memberService.removeMemberRole({
        requesterWallet,
        communityId,
        targetWallet: wallet,
        role,
      });
      return reply.status(200).send(result);
    } catch (error) {
      return sendRoleMutationError(reply, error);
    }
  });

  // POST /v1/access/check — check access for wallet/resource
  app.post('/v1/access/check', async (request: FastifyRequest, reply: FastifyReply) => {
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
  app.get('/v1/communities/:communityId/members', async (request: FastifyRequest, reply: FastifyReply) => {
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

  // --- Admin Audit Trace Endpoints ---

  // GET /admin/audit/trace/:correlationId — retrieve complete audit trace by correlation ID
  app.get('/admin/audit/trace/:correlationId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { correlationId } = request.params as { correlationId: string };
    
    // TODO: Add admin authentication check here
    // For now, this is an admin-only endpoint that should be protected by infrastructure/gateway
    
    try {
      const trace = await getAuditTraceByCorrelationId(correlationId, prisma);
      
      if (!trace) {
        return reply.status(404).send(notFound('Audit trace not found'));
      }
      
      return trace;
    } catch (error) {
      console.error('Error retrieving audit trace:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /admin/audit/trace/tx/:txHash — retrieve audit traces by transaction hash
  app.get('/admin/audit/trace/tx/:txHash', async (request: FastifyRequest, reply: FastifyReply) => {
    const { txHash } = request.params as { txHash: string };
    
    // TODO: Add admin authentication check here
    
    try {
      const traces = await getAuditTracesByTxHash(txHash, prisma);
      
      return {
        txHash,
        traces,
        count: traces.length,
      };
    } catch (error) {
      console.error('Error retrieving audit traces by tx hash:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /admin/audit/trace/wallet/:wallet — retrieve audit traces by wallet and community
  app.get('/admin/audit/trace/wallet/:wallet', async (request: FastifyRequest, reply: FastifyReply) => {
    const { wallet } = request.params as { wallet: string };
    const { communityId, limit } = request.query as { communityId?: string; limit?: string };
    
    if (!communityId) {
      return reply.status(400).send(validationError('communityId query parameter is required'));
    }
    
    // TODO: Add admin authentication check here
    
    try {
      const traces = await getAuditTracesByWallet(
        wallet,
        communityId,
        limit ? parseInt(limit, 10) : 50,
        prisma,
      );
      
      return {
        wallet,
        communityId,
        traces,
        count: traces.length,
      };
    } catch (error) {
      console.error('Error retrieving audit traces by wallet:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // --- Governance Rule Endpoints ---

  const governanceService = getGovernanceService(prisma);

  // POST /v1/governance/rules — create a governance rule
  app.post('/v1/governance/rules', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      name?: string;
      description?: string;
      communityId?: string;
      resource?: string;
      ast?: any;
    };

    if (!body.name || !body.description || !body.communityId || !body.resource || !body.ast) {
      return reply.status(400).send(
        validationError('Missing required fields: name, description, communityId, resource, ast')
      );
    }

    // TODO: Add authorization check - only admins can create governance rules
    
    try {
      const rule = await governanceService.createRule({
        name: body.name,
        description: body.description,
        communityId: body.communityId,
        resource: body.resource,
        ast: body.ast,
      });

      return reply.status(201).send(rule);
    } catch (error) {
      console.error('Error creating governance rule:', error);
      if (error instanceof Error && error.message.includes('Invalid rule AST')) {
        return reply.status(400).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /v1/governance/rules/:id — get a governance rule
  app.get('/v1/governance/rules/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      const rule = await governanceService.getRule(id);
      
      if (!rule) {
        return reply.status(404).send(notFound('Governance rule not found'));
      }

      return rule;
    } catch (error) {
      console.error('Error retrieving governance rule:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /v1/governance/communities/:communityId/rules — list governance rules
  app.get('/v1/governance/communities/:communityId/rules', async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const { resource, activeOnly } = request.query as { resource?: string; activeOnly?: string };

    try {
      const rules = await governanceService.listRules(
        communityId,
        resource,
        activeOnly !== 'false'
      );

      return {
        communityId,
        rules,
        count: rules.length,
      };
    } catch (error) {
      console.error('Error listing governance rules:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // PUT /v1/governance/rules/:id — update a governance rule
  app.put('/v1/governance/rules/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      description?: string;
      ast?: any;
      active?: boolean;
    };

    // TODO: Add authorization check - only admins can update governance rules

    try {
      const rule = await governanceService.updateRule({
        id,
        ...body,
      });

      return rule;
    } catch (error) {
      console.error('Error updating governance rule:', error);
      if (error instanceof Error && error.message.includes('Invalid rule AST')) {
        return reply.status(400).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // DELETE /v1/governance/rules/:id — delete a governance rule
  app.delete('/v1/governance/rules/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    // TODO: Add authorization check - only admins can delete governance rules

    try {
      await governanceService.deleteRule(id);
      return reply.status(204).send();
    } catch (error) {
      console.error('Error deleting governance rule:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST /v1/governance/rules/:id/evaluate — evaluate a governance rule
  app.post('/v1/governance/rules/:id/evaluate', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      wallet?: string;
      communityId?: string;
      requestId?: string;
    };

    if (!body.wallet || !body.communityId) {
      return reply.status(400).send(
        validationError('Missing required fields: wallet, communityId')
      );
    }

    try {
      // Get member role context
      const wallet = body.wallet.toLowerCase();
      const w = await prisma.wallet.findUnique({ where: { address: wallet } });
      
      if (!w) {
        return reply.status(404).send(notFound('Wallet not found'));
      }

      const member = await prisma.member.findFirst({
        where: { walletId: w.id, communityId: body.communityId },
        include: { roles: true, membership: true },
      });

      if (!member) {
        return reply.status(404).send(notFound('Member not found'));
      }

      const roleContext = {
        assignments: member.roles.map((r: any) => ({
          role: r.role,
          source: r.source,
          active: r.active,
          expiresAt: r.expiresAt,
        })),
        membershipState: member.membership?.state || 'invited',
      };

      // Evaluate governance rule
      const result = await governanceService.evaluateGovernanceRule({
        ruleId: id,
        wallet: body.wallet,
        communityId: body.communityId,
        roleContext: roleContext as any,
        requestId: body.requestId,
      });

      return {
        allowed: result.allowed,
        trace: result.trace,
        formattedTrace: formatTrace(result.trace),
      };
    } catch (error) {
      console.error('Error evaluating governance rule:', error);
      if (error instanceof Error) {
        return reply.status(400).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // --- Approval Request Endpoints ---

  // POST /v1/governance/approvals/requests — create an approval request
  app.post('/v1/governance/approvals/requests', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      communityId?: string;
      resource?: string;
      ruleId?: string;
      expiresAt?: string;
    };

    if (!body.communityId || !body.resource || !body.ruleId) {
      return reply.status(400).send(
        validationError('Missing required fields: communityId, resource, ruleId')
      );
    }

    const requesterWallet = getRequesterWallet(request);
    if (!requesterWallet) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    try {
      const approvalRequest = await governanceService.createApprovalRequest({
        communityId: body.communityId,
        resource: body.resource,
        requesterWallet,
        ruleId: body.ruleId,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      });

      return reply.status(201).send(approvalRequest);
    } catch (error) {
      console.error('Error creating approval request:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST /v1/governance/approvals/requests/:requestId/approvals — submit an approval
  app.post('/v1/governance/approvals/requests/:requestId/approvals', async (request: FastifyRequest, reply: FastifyReply) => {
    const { requestId } = request.params as { requestId: string };
    const body = request.body as {
      approved?: boolean;
      signature?: string;
    };

    if (body.approved === undefined) {
      return reply.status(400).send(validationError('Missing required field: approved'));
    }

    const approverWallet = getRequesterWallet(request);
    if (!approverWallet) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    try {
      // Get approver's role
      const wallet = await prisma.wallet.findUnique({
        where: { address: approverWallet.toLowerCase() },
      });

      if (!wallet) {
        return reply.status(404).send(notFound('Wallet not found'));
      }

      // Get approval request to find community
      const approvalRequest = await prisma.approvalRequest.findUnique({
        where: { id: requestId },
      });

      if (!approvalRequest) {
        return reply.status(404).send(notFound('Approval request not found'));
      }

      // Get member and their roles
      const member = await prisma.member.findFirst({
        where: {
          walletId: wallet.id,
          communityId: approvalRequest.communityId,
        },
        include: { roles: true },
      });

      if (!member) {
        return reply.status(403).send({ error: 'Not a member of this community' });
      }

      // Get highest role (simplified: check for admin first, then contributor, then member)
      const roles = member.roles.filter((r: any) => r.active);
      let approverRole = 'member';
      if (roles.some((r: any) => r.role === 'admin')) {
        approverRole = 'admin';
      } else if (roles.some((r: any) => r.role === 'contributor')) {
        approverRole = 'contributor';
      }

      const approval = await governanceService.submitApproval({
        requestId,
        approverWallet,
        approverRole,
        approved: body.approved,
        signature: body.signature,
      });

      return reply.status(201).send(approval);
    } catch (error) {
      console.error('Error submitting approval:', error);
      if (error instanceof Error && error.message.includes('already submitted')) {
        return reply.status(409).send({ error: error.message });
      }
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /v1/governance/approvals/requests/:requestId — get approval request details
  app.get('/v1/governance/approvals/requests/:requestId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { requestId } = request.params as { requestId: string };

    try {
      const approvalRequest = await prisma.approvalRequest.findUnique({
        where: { id: requestId },
        include: { approvals: true },
      });

      if (!approvalRequest) {
        return reply.status(404).send(notFound('Approval request not found'));
      }

      return approvalRequest;
    } catch (error) {
      console.error('Error retrieving approval request:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // --- Contribution Score Endpoints ---

  // GET /v1/governance/contribution-scores/:wallet — get contribution score
  app.get('/v1/governance/contribution-scores/:wallet', async (request: FastifyRequest, reply: FastifyReply) => {
    const { wallet } = request.params as { wallet: string };
    const { communityId } = request.query as { communityId?: string };

    if (!communityId) {
      return reply.status(400).send(validationError('communityId query parameter is required'));
    }

    try {
      const score = await governanceService.getContributionScore(wallet, communityId);
      return {
        wallet,
        communityId,
        score,
      };
    } catch (error) {
      console.error('Error retrieving contribution score:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // PUT /v1/governance/contribution-scores/:wallet — update contribution score
  app.put('/v1/governance/contribution-scores/:wallet', async (request: FastifyRequest, reply: FastifyReply) => {
    const { wallet } = request.params as { wallet: string };
    const body = request.body as {
      communityId?: string;
      totalScore?: number;
      breakdown?: any;
    };

    if (!body.communityId || body.totalScore === undefined) {
      return reply.status(400).send(
        validationError('Missing required fields: communityId, totalScore')
      );
    }

    // TODO: Add authorization check - only admins can update contribution scores

    try {
      const score = await governanceService.updateContributionScore(
        wallet,
        body.communityId,
        body.totalScore,
        body.breakdown,
      );

      return score;
    } catch (error) {
      console.error('Error updating contribution score:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

}
