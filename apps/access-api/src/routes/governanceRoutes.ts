import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RuleNode } from '@guildpass/governance-engine';
import {
  GovernanceService,
  GovernanceServiceError,
} from '../services/governanceService';
import { conflict, notFound, validationError, createApiError } from '../errors';
import {
  createGovernanceRuleSchema,
  listGovernanceRulesSchema,
  getGovernanceRuleSchema,
  updateGovernanceRuleSchema,
  deleteGovernanceRuleSchema,
  createApprovalRequestSchema,
  submitApprovalSchema,
  listApprovalsSchema,
} from '../schemas';

export type GovernanceServiceLike = Pick<
  GovernanceService,
  | 'createRule'
  | 'updateRule'
  | 'getRule'
  | 'listRules'
  | 'deleteRule'
  | 'createApprovalRequest'
  | 'submitApproval'
  | 'getApprovals'
>;

export interface GovernanceRoutesDeps {
  governanceService: GovernanceServiceLike;
  requireCommunityAdmin: (
    communityId: string,
    requesterWallet: string,
  ) => Promise<boolean>;
  getRequesterWallet: (request: FastifyRequest) => string;
}

function sendGovernanceError(reply: FastifyReply, error: unknown) {
  if (error instanceof GovernanceServiceError) {
    return reply.status(error.statusCode).send(
      createApiError({
        statusCode: error.statusCode,
        code: 'GOVERNANCE_ERROR',
        message: error.message,
      }),
    );
  }
  if ((error as { code?: string })?.code === 'P2025') {
    return reply.status(404).send(notFound('Governance rule not found'));
  }
  if ((error as { code?: string })?.code === 'P2002') {
    return reply
      .status(409)
      .send(conflict('A governance rule with this name already exists for the resource'));
  }
  return reply
    .status(500)
    .send(createApiError({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' }));
}

export function registerGovernanceRoutes(
  app: FastifyInstance,
  deps: GovernanceRoutesDeps,
): void {
  const { governanceService, requireCommunityAdmin, getRequesterWallet } = deps;

  const forbidden = (reply: FastifyReply) =>
    reply.status(403).send({ error: 'Forbidden' });

  // POST /v1/communities/:communityId/governance-rules — create a rule (admin)
  app.post(
    '/v1/communities/:communityId/governance-rules',
    { schema: createGovernanceRuleSchema },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId } = request.params as { communityId: string };
      const body = request.body as {
        name?: string;
        description?: string;
        resource?: string;
        ast?: RuleNode;
      };
      if (!body?.name || !body?.description || !body?.resource || !body?.ast) {
        return reply
          .status(400)
          .send(validationError('Missing required fields: name, description, resource, ast'));
      }
      const requester = getRequesterWallet(request);
      try {
        if (!(await requireCommunityAdmin(communityId, requester))) {
          return forbidden(reply);
        }
        const rule = await governanceService.createRule({
          name: body.name,
          description: body.description,
          communityId,
          resource: body.resource,
          ast: body.ast,
        });
        return reply.status(201).send(rule);
      } catch (error) {
        return sendGovernanceError(reply, error);
      }
    },
  );

  // GET /v1/communities/:communityId/governance-rules — list rules (admin)
  app.get(
    '/v1/communities/:communityId/governance-rules',
    { schema: listGovernanceRulesSchema },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId } = request.params as { communityId: string };
      const query = request.query as { resource?: string; activeOnly?: string };
      const requester = getRequesterWallet(request);
      try {
        if (!(await requireCommunityAdmin(communityId, requester))) {
          return forbidden(reply);
        }
        const activeOnly = query.activeOnly === 'false' ? false : true;
        const rules = await governanceService.listRules(
          communityId,
          query.resource,
          activeOnly,
        );
        return reply.status(200).send({ rules });
      } catch (error) {
        return sendGovernanceError(reply, error);
      }
    },
  );

  // GET /v1/communities/:communityId/governance-rules/:ruleId — get one (admin)
  app.get(
    '/v1/communities/:communityId/governance-rules/:ruleId',
    { schema: getGovernanceRuleSchema },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, ruleId } = request.params as {
        communityId: string;
        ruleId: string;
      };
      const requester = getRequesterWallet(request);
      try {
        if (!(await requireCommunityAdmin(communityId, requester))) {
          return forbidden(reply);
        }
        const rule = await governanceService.getRule(ruleId);
        if (!rule || rule.communityId !== communityId) {
          return reply.status(404).send(notFound('Governance rule not found'));
        }
        return reply.status(200).send(rule);
      } catch (error) {
        return sendGovernanceError(reply, error);
      }
    },
  );

  // PATCH /v1/communities/:communityId/governance-rules/:ruleId — update (admin)
  app.patch(
    '/v1/communities/:communityId/governance-rules/:ruleId',
    { schema: updateGovernanceRuleSchema },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, ruleId } = request.params as {
        communityId: string;
        ruleId: string;
      };
      const body = request.body as {
        name?: string;
        description?: string;
        ast?: RuleNode;
        active?: boolean;
      };
      const requester = getRequesterWallet(request);
      try {
        if (!(await requireCommunityAdmin(communityId, requester))) {
          return forbidden(reply);
        }
        const existing = await governanceService.getRule(ruleId);
        if (!existing || existing.communityId !== communityId) {
          return reply.status(404).send(notFound('Governance rule not found'));
        }
        const rule = await governanceService.updateRule({
          id: ruleId,
          name: body.name,
          description: body.description,
          ast: body.ast,
          active: body.active,
        });
        return reply.status(200).send(rule);
      } catch (error) {
        return sendGovernanceError(reply, error);
      }
    },
  );

  // DELETE /v1/communities/:communityId/governance-rules/:ruleId — delete (admin)
  app.delete(
    '/v1/communities/:communityId/governance-rules/:ruleId',
    { schema: deleteGovernanceRuleSchema },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, ruleId } = request.params as {
        communityId: string;
        ruleId: string;
      };
      const requester = getRequesterWallet(request);
      try {
        if (!(await requireCommunityAdmin(communityId, requester))) {
          return forbidden(reply);
        }
        const existing = await governanceService.getRule(ruleId);
        if (!existing || existing.communityId !== communityId) {
          return reply.status(404).send(notFound('Governance rule not found'));
        }
        await governanceService.deleteRule(ruleId);
        return reply.status(204).send();
      } catch (error) {
        return sendGovernanceError(reply, error);
      }
    },
  );

  // POST /v1/communities/:communityId/governance-rules/:ruleId/approval-requests
  app.post(
    '/v1/communities/:communityId/governance-rules/:ruleId/approval-requests',
    { schema: createApprovalRequestSchema },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, ruleId } = request.params as {
        communityId: string;
        ruleId: string;
      };
      const body = request.body as { expiresAt?: string | null };
      const requester = getRequesterWallet(request);
      if (!requester) {
        return reply
          .status(400)
          .send(validationError('Missing requester wallet (x-wallet header)'));
      }
      try {
        const rule = await governanceService.getRule(ruleId);
        if (!rule || rule.communityId !== communityId) {
          return reply.status(404).send(notFound('Governance rule not found'));
        }
        const approvalRequest = await governanceService.createApprovalRequest({
          communityId,
          resource: rule.resource,
          requesterWallet: requester,
          ruleId,
          expiresAt: body?.expiresAt ? new Date(body.expiresAt) : undefined,
        });
        return reply.status(201).send(approvalRequest);
      } catch (error) {
        return sendGovernanceError(reply, error);
      }
    },
  );

  // POST /v1/communities/:communityId/approval-requests/:requestId/approvals
  app.post(
    '/v1/communities/:communityId/approval-requests/:requestId/approvals',
    { schema: submitApprovalSchema },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { requestId } = request.params as { requestId: string };
      const body = request.body as {
        approverRole?: string;
        approved?: boolean;
        signature?: string;
      };
      const requester = getRequesterWallet(request);
      if (!requester) {
        return reply
          .status(400)
          .send(validationError('Missing requester wallet (x-wallet header)'));
      }
      if (!body?.approverRole || typeof body?.approved !== 'boolean') {
        return reply
          .status(400)
          .send(validationError('Missing required fields: approverRole, approved'));
      }
      try {
        const approval = await governanceService.submitApproval({
          requestId,
          approverWallet: requester,
          approverRole: body.approverRole,
          approved: body.approved,
          signature: body.signature,
        });
        return reply.status(201).send(approval);
      } catch (error) {
        return sendGovernanceError(reply, error);
      }
    },
  );

  // GET /v1/communities/:communityId/approval-requests/:requestId/approvals
  app.get(
    '/v1/communities/:communityId/approval-requests/:requestId/approvals',
    { schema: listApprovalsSchema },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { requestId } = request.params as { requestId: string };
      try {
        const approvals = await governanceService.getApprovals(requestId);
        return reply.status(200).send({ approvals });
      } catch (error) {
        return sendGovernanceError(reply, error);
      }
    },
  );
}
