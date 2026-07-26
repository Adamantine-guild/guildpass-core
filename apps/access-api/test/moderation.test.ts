import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { registerRoutes } from '../src/routes';
import { getModerationService, ModerationError } from '../src/services/moderation/moderationService';

// ---------------------------------------------------------------------------
// Mock Prisma Client
// ---------------------------------------------------------------------------

const mockPrisma = {
  member: {
    findFirst: jest.fn(),
  },
  appeal: {
    findFirst: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  membership: {
    update: jest.fn(),
  },
  membershipToken: {
    update: jest.fn(),
  },
  outboxEvent: {
    create: jest.fn(),
  },
  auditEvent: {
    create: jest.fn(),
  },
  $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
};

// Mock the prisma service
jest.mock('../src/services/prisma', () => ({
  getPrisma: () => mockPrisma,
}));

// Mock the audit chain service
jest.mock('../src/services/auditChainHasher', () => ({
  writeChainedAuditEvent: jest.fn().mockResolvedValue({ id: 'audit-event-id' }),
}));

describe('Moderation appeals & Reinstatement integration', () => {
  let app: FastifyInstance;
  const wallet = '0x1234567890123456789012345678901234567890';
  const communityId = 'community-test';

  beforeAll(async () => {
    app = Fastify();
    await registerRoutes(app);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Filing an appeal', () => {
    test('should reject appeal if member does not exist', async () => {
      (mockPrisma.member.findFirst as jest.Mock).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: `/v1/memberships/${wallet}/appeals`,
        payload: {
          communityId,
          reason: 'I want to appeal my suspension',
        },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toContain('Member not found');
    });

    test('should reject appeal if membership is not suspended', async () => {
      (mockPrisma.member.findFirst as jest.Mock).mockResolvedValue({
        id: 'member-1',
        communityId,
        wallet: { address: wallet.toLowerCase() },
        membership: { activeToken: { state: 'active' } },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/memberships/${wallet}/appeals`,
        payload: {
          communityId,
          reason: 'I want to appeal',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain('Membership is not suspended');
    });

    test('should reject appeal if an active appeal already exists', async () => {
      (mockPrisma.member.findFirst as jest.Mock).mockResolvedValue({
        id: 'member-1',
        communityId,
        wallet: { address: wallet.toLowerCase() },
        membership: { activeToken: { state: 'suspended' } },
      });

      (mockPrisma.appeal.findFirst as jest.Mock).mockResolvedValue({
        id: 'existing-appeal-id',
        status: 'filed',
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/memberships/${wallet}/appeals`,
        payload: {
          communityId,
          reason: 'Another appeal',
        },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error).toContain('An active appeal already exists');
    });

    test('should successfully file an appeal if suspended and no active appeal exists', async () => {
      (mockPrisma.member.findFirst as jest.Mock).mockResolvedValue({
        id: 'member-1',
        communityId,
        wallet: { address: wallet.toLowerCase() },
        membership: { activeToken: { state: 'suspended' } },
      });

      (mockPrisma.appeal.findFirst as jest.Mock).mockResolvedValue(null);

      (mockPrisma.appeal.create as jest.Mock).mockResolvedValue({
        id: 'appeal-1',
        memberId: 'member-1',
        reason: 'Valid appeal reason',
        status: 'filed',
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/memberships/${wallet}/appeals`,
        payload: {
          communityId,
          reason: 'Valid appeal reason',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe('appeal-1');
      expect(body.status).toBe('filed');
      expect(mockPrisma.appeal.create).toHaveBeenCalled();
    });
  });

  describe('Transitioning an appeal', () => {
    test('should reject transition if state machine rule is violated (e.g. filed -> reinstated)', async () => {
      (mockPrisma.appeal.findUnique as jest.Mock).mockResolvedValue({
        id: 'appeal-123',
        status: 'filed',
        member: {
          wallet: { address: wallet.toLowerCase() },
          communityId,
          membership: { id: 'membership-1', state: 'suspended' },
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/appeals/appeal-123/transition',
        headers: {
          'x-api-key': 'test-api-key',
        },
        payload: {
          status: 'reinstated',
          adminComment: 'Direct transition not allowed',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain('Invalid transition from filed to reinstated');
    });

    test('should allow transition to under_review, and then to reinstated', async () => {
      // 1. Transition filed -> under_review
      (mockPrisma.appeal.findUnique as jest.Mock).mockResolvedValue({
        id: 'appeal-123',
        status: 'filed',
        member: {
          wallet: { address: wallet.toLowerCase() },
          communityId,
          membership: { id: 'membership-1', state: 'suspended' },
        },
      });

      (mockPrisma.appeal.update as jest.Mock).mockResolvedValue({
        id: 'appeal-123',
        status: 'under_review',
      });

      let response = await app.inject({
        method: 'POST',
        url: '/v1/appeals/appeal-123/transition',
        headers: {
          'x-api-key': 'test-api-key',
        },
        payload: {
          status: 'under_review',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).status).toBe('under_review');

      // 2. Transition under_review -> reinstated
      (mockPrisma.appeal.findUnique as jest.Mock).mockResolvedValue({
        id: 'appeal-123',
        status: 'under_review',
        member: {
          wallet: { address: wallet.toLowerCase() },
          communityId,
          membership: { id: 'membership-1', activeTokenId: 999 },
        },
      });

      (mockPrisma.appeal.update as jest.Mock).mockResolvedValue({
        id: 'appeal-123',
        status: 'reinstated',
      });

      response = await app.inject({
        method: 'POST',
        url: '/v1/appeals/appeal-123/transition',
        headers: {
          'x-api-key': 'test-api-key',
        },
        payload: {
          status: 'reinstated',
          adminComment: 'Suspension lifted.',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).status).toBe('reinstated');
      
      // Verification of side-effects
      expect(mockPrisma.membershipToken.update).toHaveBeenCalledWith({
        where: { tokenId: 999 },
        data: { state: 'active' },
      });
      expect(mockPrisma.outboxEvent.create).toHaveBeenCalled();
    });
  });
});
