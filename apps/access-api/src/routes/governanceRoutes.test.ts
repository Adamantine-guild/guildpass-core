import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  registerGovernanceRoutes,
  type GovernanceServiceLike,
} from './governanceRoutes';

const ADMIN_WALLET = '0xadmin';
const RULE = {
  id: 'rule-1',
  name: 'Founders only',
  description: 'Only founders may enter',
  communityId: 'community-1',
  resource: 'vault',
  ast: { type: 'HasRole', role: 'admin' },
  active: true,
};

function createMockService(
  overrides: Partial<Record<keyof GovernanceServiceLike, jest.Mock>> = {},
): { [K in keyof GovernanceServiceLike]: jest.Mock } {
  return {
    createRule: overrides.createRule ?? jest.fn(),
    updateRule: overrides.updateRule ?? jest.fn(),
    getRule: overrides.getRule ?? jest.fn(),
    listRules: overrides.listRules ?? jest.fn(),
    deleteRule: overrides.deleteRule ?? jest.fn(),
    createApprovalRequest: overrides.createApprovalRequest ?? jest.fn(),
    submitApproval: overrides.submitApproval ?? jest.fn(),
    getApprovals: overrides.getApprovals ?? jest.fn(),
  };
}

async function buildApp(
  service: ReturnType<typeof createMockService>,
  opts: { isAdmin?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify();
  registerGovernanceRoutes(app, {
    governanceService: service as unknown as GovernanceServiceLike,
    requireCommunityAdmin: async () => opts.isAdmin ?? true,
    getRequesterWallet: (request: FastifyRequest) =>
      (request.headers['x-wallet'] as string) ?? '',
  });
  await app.ready();
  return app;
}

const adminHeaders = { 'x-wallet': ADMIN_WALLET };

describe('governance routes', () => {
  describe('POST /v1/communities/:communityId/governance-rules', () => {
    it('creates a rule and returns 201', async () => {
      const service = createMockService({
        createRule: jest.fn().mockResolvedValue(RULE),
      });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/communities/community-1/governance-rules',
        headers: adminHeaders,
        payload: {
          name: RULE.name,
          description: RULE.description,
          resource: RULE.resource,
          ast: RULE.ast,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: 'rule-1', resource: 'vault' });
      expect(service.createRule).toHaveBeenCalledWith(
        expect.objectContaining({ communityId: 'community-1', resource: 'vault' }),
      );
      await app.close();
    });

    it('returns 400 when required fields are missing', async () => {
      const service = createMockService();
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/communities/community-1/governance-rules',
        headers: adminHeaders,
        payload: { name: 'x' },
      });

      expect(res.statusCode).toBe(400);
      expect(service.createRule).not.toHaveBeenCalled();
      await app.close();
    });

    it('returns 403 for non-admins', async () => {
      const service = createMockService({ createRule: jest.fn() });
      const app = await buildApp(service, { isAdmin: false });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/communities/community-1/governance-rules',
        headers: adminHeaders,
        payload: {
          name: RULE.name,
          description: RULE.description,
          resource: RULE.resource,
          ast: RULE.ast,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(service.createRule).not.toHaveBeenCalled();
      await app.close();
    });

    it('maps GovernanceServiceError (invalid AST) to 400', async () => {
      const { GovernanceServiceError } = await import('../services/governanceService');
      const service = createMockService({
        createRule: jest
          .fn()
          .mockRejectedValue(new GovernanceServiceError('Invalid rule AST: bad', 400)),
      });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/communities/community-1/governance-rules',
        headers: adminHeaders,
        payload: {
          name: RULE.name,
          description: RULE.description,
          resource: RULE.resource,
          ast: { type: 'Nonsense' },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('Invalid rule AST');
      await app.close();
    });
  });

  describe('GET /v1/communities/:communityId/governance-rules', () => {
    it('lists rules', async () => {
      const service = createMockService({
        listRules: jest.fn().mockResolvedValue([RULE]),
      });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/communities/community-1/governance-rules',
        headers: adminHeaders,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().rules).toHaveLength(1);
      expect(service.listRules).toHaveBeenCalledWith('community-1', undefined, true);
      await app.close();
    });

    it('passes resource filter and activeOnly=false through', async () => {
      const service = createMockService({
        listRules: jest.fn().mockResolvedValue([]),
      });
      const app = await buildApp(service);

      await app.inject({
        method: 'GET',
        url: '/v1/communities/community-1/governance-rules?resource=vault&activeOnly=false',
        headers: adminHeaders,
      });

      expect(service.listRules).toHaveBeenCalledWith('community-1', 'vault', false);
      await app.close();
    });
  });

  describe('GET /v1/communities/:communityId/governance-rules/:ruleId', () => {
    it('returns the rule', async () => {
      const service = createMockService({
        getRule: jest.fn().mockResolvedValue(RULE),
      });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/communities/community-1/governance-rules/rule-1',
        headers: adminHeaders,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe('rule-1');
      await app.close();
    });

    it('returns 404 when the rule belongs to another community', async () => {
      const service = createMockService({
        getRule: jest.fn().mockResolvedValue({ ...RULE, communityId: 'other' }),
      });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/communities/community-1/governance-rules/rule-1',
        headers: adminHeaders,
      });

      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe('PATCH /v1/communities/:communityId/governance-rules/:ruleId', () => {
    it('updates a rule', async () => {
      const service = createMockService({
        getRule: jest.fn().mockResolvedValue(RULE),
        updateRule: jest.fn().mockResolvedValue({ ...RULE, active: false }),
      });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/communities/community-1/governance-rules/rule-1',
        headers: adminHeaders,
        payload: { active: false },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().active).toBe(false);
      expect(service.updateRule).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'rule-1', active: false }),
      );
      await app.close();
    });

    it('returns 404 for an unknown rule', async () => {
      const service = createMockService({
        getRule: jest.fn().mockResolvedValue(null),
        updateRule: jest.fn(),
      });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/communities/community-1/governance-rules/rule-1',
        headers: adminHeaders,
        payload: { active: false },
      });

      expect(res.statusCode).toBe(404);
      expect(service.updateRule).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('DELETE /v1/communities/:communityId/governance-rules/:ruleId', () => {
    it('deletes a rule and returns 204', async () => {
      const service = createMockService({
        getRule: jest.fn().mockResolvedValue(RULE),
        deleteRule: jest.fn().mockResolvedValue(undefined),
      });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/communities/community-1/governance-rules/rule-1',
        headers: adminHeaders,
      });

      expect(res.statusCode).toBe(204);
      expect(service.deleteRule).toHaveBeenCalledWith('rule-1');
      await app.close();
    });
  });

  describe('approval workflow', () => {
    it('creates an approval request (201) using the rule resource', async () => {
      const service = createMockService({
        getRule: jest.fn().mockResolvedValue(RULE),
        createApprovalRequest: jest
          .fn()
          .mockResolvedValue({ id: 'req-1', status: 'pending' }),
      });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/communities/community-1/governance-rules/rule-1/approval-requests',
        headers: { 'x-wallet': '0xrequester' },
        payload: {},
      });

      expect(res.statusCode).toBe(201);
      expect(service.createApprovalRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'community-1',
          resource: 'vault',
          requesterWallet: '0xrequester',
          ruleId: 'rule-1',
        }),
      );
      await app.close();
    });

    it('submits an approval (201)', async () => {
      const service = createMockService({
        submitApproval: jest.fn().mockResolvedValue({ id: 'appr-1', approved: true }),
      });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/communities/community-1/approval-requests/req-1/approvals',
        headers: { 'x-wallet': ADMIN_WALLET },
        payload: { approverRole: 'admin', approved: true },
      });

      expect(res.statusCode).toBe(201);
      expect(service.submitApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-1',
          approverWallet: ADMIN_WALLET,
          approverRole: 'admin',
          approved: true,
        }),
      );
      await app.close();
    });

    it('maps a duplicate approval to 409', async () => {
      const { GovernanceServiceError } = await import('../services/governanceService');
      const service = createMockService({
        submitApproval: jest
          .fn()
          .mockRejectedValue(
            new GovernanceServiceError('Approval already submitted by this wallet', 409),
          ),
      });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/communities/community-1/approval-requests/req-1/approvals',
        headers: { 'x-wallet': ADMIN_WALLET },
        payload: { approverRole: 'admin', approved: true },
      });

      expect(res.statusCode).toBe(409);
      await app.close();
    });

    it('rejects an approval submission with missing fields (400)', async () => {
      const service = createMockService({ submitApproval: jest.fn() });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/communities/community-1/approval-requests/req-1/approvals',
        headers: { 'x-wallet': ADMIN_WALLET },
        payload: { approverRole: 'admin' },
      });

      expect(res.statusCode).toBe(400);
      expect(service.submitApproval).not.toHaveBeenCalled();
      await app.close();
    });

    it('lists approvals for a request', async () => {
      const service = createMockService({
        getApprovals: jest
          .fn()
          .mockResolvedValue([{ id: 'appr-1', approverWallet: ADMIN_WALLET }]),
      });
      const app = await buildApp(service);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/communities/community-1/approval-requests/req-1/approvals',
        headers: adminHeaders,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().approvals).toHaveLength(1);
      await app.close();
    });
  });
});
