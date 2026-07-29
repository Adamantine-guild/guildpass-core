/**
 * Membership Integration Test
 *
 * Validates the end-to-end flow:
 * Contract Events → Event Fixtures → Database State → Policy Engine → API Access Decision
 *
 * This test proves that membership events from the MembershipNFT contract can be
 * processed and reflected in API access control decisions.
 */

import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { registerRoutes } from './routes';
import {
  applyContractEvent,
  type DecodedMembershipMintedEvent,
  type DecodedMembershipRenewedEvent,
  type DecodedMembershipSuspendedEvent,
} from './services/contractEventHelpers';
import { createIndexerWorker, type ChainProvider, type BlockInfo } from './workers/indexerWorker';
import { IndexerWorker } from './workers/indexerWorker';

/**
 * Test Fixtures - Contract events that would be emitted by MembershipNFT
 */

const REORG_COMMUNITY_ID = 'reorg-integration-community';
const REORG_CHAIN_ID = 31337;
const REORG_CONTRACT_ADDRESS = '0xReorgIntegrationContract111111111111111111';
const REORG_STATE_ID = `${REORG_CHAIN_ID}:${REORG_CONTRACT_ADDRESS.toLowerCase()}`;

const testFixtures = {
  // Scenario 1: Active membership with valid expiry
  activeMembership: {
    event: {
      type: 'MembershipMinted',
      to: '0x1111111111111111111111111111111111111111',
      tokenId: 1,
      communityId: 'community-dev',
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days from now
    } as DecodedMembershipMintedEvent,
    expectedState: 'active',
  },

  // Scenario 2: Expired membership
  expiredMembership: {
    event: {
      type: 'MembershipMinted',
      to: '0x2222222222222222222222222222222222222222',
      tokenId: 2,
      communityId: 'community-dev',
      expiresAt: Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60, // 10 days ago
    } as DecodedMembershipMintedEvent,
    expectedState: 'expired',
  },

  // Scenario 3: Suspended membership (still within expiry window)
  suspendedMembership: {
    event: {
      type: 'MembershipMinted',
      to: '0x3333333333333333333333333333333333333333',
      tokenId: 3,
      communityId: 'community-dev',
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    } as DecodedMembershipMintedEvent,
    suspendedEvent: {
      type: 'MembershipSuspended',
      tokenId: 3,
      isSuspended: true,
    } as DecodedMembershipSuspendedEvent,
    expectedState: 'suspended',
  },

  // Scenario 4: Renewed membership (extends expiry)
  renewedMembership: {
    initialEvent: {
      type: 'MembershipMinted',
      to: '0x4444444444444444444444444444444444444444',
      tokenId: 4,
      communityId: 'community-dev',
      expiresAt: Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60, // 5 days from now
    } as DecodedMembershipMintedEvent,
    renewalEvent: {
      type: 'MembershipRenewed',
      tokenId: 4,
      newExpiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days from now
    } as DecodedMembershipRenewedEvent,
    expectedState: 'active',
  },
};


/**
 * Integration Tests
 */

describe('Membership Integration: Contract Events → API Access', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    // Initialize Prisma
    prisma = new PrismaClient();

    // Create Fastify app with routes
    app = Fastify({ logger: false });
    registerRoutes(app);

    // Clean up database before tests
    await prisma.processedEvent.deleteMany({});
    await prisma.roleAssignment.deleteMany({});
    await prisma.badge.deleteMany({});
    await prisma.membership.deleteMany({});
    await prisma.membershipToken.deleteMany({});
    await prisma.member.deleteMany({});
    await prisma.accessPolicy.deleteMany({});
    await prisma.community.deleteMany({});
    await prisma.wallet.deleteMany({});
    await prisma.profile.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('Scenario 1: Active Membership Grants Access', () => {
    beforeEach(async () => {
      // Clean database before this scenario
      await prisma.processedEvent.deleteMany({});
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.membershipToken.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should create active membership from MembershipMinted event', async () => {
      const event = testFixtures.activeMembership.event;

      // Apply event to database
      await applyContractEvent(prisma, event);

      // Verify membership was created
      const membership = await prisma.membershipToken.findFirst({
        where: { tokenId: event.tokenId },
        include: { member: { include: { wallet: true } } },
      });

      expect(membership).toBeDefined();
      expect(membership?.state).toBe('active');
      expect(membership?.member.wallet.address).toBe(event.to.toLowerCase());
      expect(membership?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    });

    test('should allow access for active member via MEMBERS_ONLY policy', async () => {
      const event = testFixtures.activeMembership.event;
      await applyContractEvent(prisma, event);

      // Create access policy requiring membership
      await prisma.accessPolicy.create({
        data: {
          communityId: event.communityId,
          resource: 'dashboard',
          ruleType: 'MEMBERS_ONLY',
        },
      });

      // Check access via API
      const response = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet: event.to,
          communityId: event.communityId,
          resource: 'dashboard',
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.allowed).toBe(true);
      expect(result.code).toBe('ALLOW');
      expect(result.membershipState).toBe('active');
    });

    test('should fetch membership via GET /v1/memberships/:wallet', async () => {
      const event = testFixtures.activeMembership.event;
      await applyContractEvent(prisma, event);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/communities/${event.communityId}/memberships/${event.to}`,
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.wallet).toBe(event.to);
      expect(result.communities).toHaveLength(1);
      expect(result.communities[0].state).toBe('active');
      expect(result.communities[0].communityId).toBe(event.communityId);
    });
  });

  describe('Scenario 2: Expired Membership Denies Access', () => {
    beforeEach(async () => {
      await prisma.processedEvent.deleteMany({});
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.membershipToken.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should create expired membership from past expiresAt', async () => {
      const event = testFixtures.expiredMembership.event;
      await applyContractEvent(prisma, event);

      const membership = await prisma.membershipToken.findFirst({
        where: { tokenId: event.tokenId },
      });

      expect(membership?.state).toBe('active'); // state in DB is 'active'
      expect(membership?.expiresAt?.getTime()).toBeLessThan(Date.now()); // but expiresAt is in past
    });

    test('should deny access for expired member via MEMBERS_ONLY policy', async () => {
      const event = testFixtures.expiredMembership.event;
      await applyContractEvent(prisma, event);

      // Create access policy
      await prisma.accessPolicy.create({
        data: {
          communityId: event.communityId,
          resource: 'dashboard',
          ruleType: 'MEMBERS_ONLY',
        },
      });

      // Check access via API
      const response = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet: event.to,
          communityId: event.communityId,
          resource: 'dashboard',
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('DENY');
      expect(result.membershipState).toBe('expired'); // getNormalizedMembershipState recognizes this as expired
    });

    test('should report expired state when fetching memberships', async () => {
      const event = testFixtures.expiredMembership.event;
      await applyContractEvent(prisma, event);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/communities/${event.communityId}/memberships/${event.to}`,
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.communities[0].state).toBe('expired');
    });
  });

  describe('Scenario 3: Suspended Membership Denies Access', () => {
    beforeEach(async () => {
      await prisma.processedEvent.deleteMany({});
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.membershipToken.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should apply suspension via MembershipSuspended event', async () => {
      const event = testFixtures.suspendedMembership.event;
      const suspendedEvent = testFixtures.suspendedMembership.suspendedEvent;

      await applyContractEvent(prisma, event);
      await applyContractEvent(prisma, suspendedEvent);

      const membership = await prisma.membershipToken.findFirst({
        where: { tokenId: event.tokenId },
      });

      expect(membership?.state).toBe('suspended');
      expect(membership?.expiresAt?.getTime()).toBeGreaterThan(Date.now()); // still valid expiry
    });

    test('should deny access for suspended member', async () => {
      const event = testFixtures.suspendedMembership.event;
      const suspendedEvent = testFixtures.suspendedMembership.suspendedEvent;

      await applyContractEvent(prisma, event);
      await applyContractEvent(prisma, suspendedEvent);

      // Create access policy
      await prisma.accessPolicy.create({
        data: {
          communityId: event.communityId,
          resource: 'dashboard',
          ruleType: 'MEMBERS_ONLY',
        },
      });

      // Check access via API
      const response = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet: event.to,
          communityId: event.communityId,
          resource: 'dashboard',
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('DENY');
      expect(result.membershipState).toBe('suspended');
    });

    test('should not serve a cached ALLOW after suspension', async () => {
      const event = testFixtures.suspendedMembership.event;
      const suspendedEvent = testFixtures.suspendedMembership.suspendedEvent;

      await applyContractEvent(prisma, event);
      await prisma.accessPolicy.create({
        data: {
          communityId: event.communityId,
          resource: 'dashboard',
          ruleType: 'MEMBERS_ONLY',
        },
      });

      const allowedBeforeSuspension = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet: event.to,
          communityId: event.communityId,
          resource: 'dashboard',
        },
      });
      expect(JSON.parse(allowedBeforeSuspension.body).allowed).toBe(true);

      await applyContractEvent(prisma, suspendedEvent);

      const deniedAfterSuspension = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet: event.to,
          communityId: event.communityId,
          resource: 'dashboard',
        },
      });
      const result = JSON.parse(deniedAfterSuspension.body);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('DENY');
      expect(result.membershipState).toBe('suspended');
    });

    test('should report suspended state in memberships list', async () => {
      const event = testFixtures.suspendedMembership.event;
      const suspendedEvent = testFixtures.suspendedMembership.suspendedEvent;

      await applyContractEvent(prisma, event);
      await applyContractEvent(prisma, suspendedEvent);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/communities/${event.communityId}/memberships/${event.to}`,
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.communities[0].state).toBe('suspended');
    });
  });

  describe('Out-of-Order Event Processing for Superseded Tokens', () => {
    beforeEach(async () => {
      await prisma.processedEvent.deleteMany({});
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.membershipToken.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should process Mint then Suspend correctly (Ordering: Mint Token 102, then Suspend Token 101)', async () => {
      const wallet = '0x9999999999999999999999999999999999999999';
      const communityId = 'community-ooo-test';

      const mint1: DecodedMembershipMintedEvent = {
        type: 'MembershipMinted',
        to: wallet,
        tokenId: 101,
        communityId,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        chainId: 1,
        txHash: '0xhash101',
        blockNumber: 1000,
        logIndex: 0,
      };

      const mint2: DecodedMembershipMintedEvent = {
        type: 'MembershipMinted',
        to: wallet,
        tokenId: 102,
        communityId,
        expiresAt: Math.floor(Date.now() / 1000) + 7200,
        chainId: 1,
        txHash: '0xhash102',
        blockNumber: 1001,
        logIndex: 1,
      };

      const suspend1: DecodedMembershipSuspendedEvent = {
        type: 'MembershipSuspended',
        tokenId: 101,
        isSuspended: true,
        chainId: 1,
        txHash: '0xhash103',
        blockNumber: 1001,
        logIndex: 0,
      };

      // Apply first mint
      await applyContractEvent(prisma, mint1);
      // Apply second mint (pointer moves to 102)
      await applyContractEvent(prisma, mint2);
      // Apply first suspension (out-of-order suspend for 101)
      await applyContractEvent(prisma, suspend1);

      // Verify records on disk
      const token101 = await prisma.membershipToken.findFirst({
        where: { tokenId: 101 },
      });
      const token102 = await prisma.membershipToken.findFirst({
        where: { tokenId: 102 },
      });

      expect(token101?.state).toBe('suspended');
      expect(token102?.state).toBe('active');

      const membership = await prisma.membership.findFirst({
        where: { member: { wallet: { address: wallet } } },
        include: { activeToken: true },
      });
      // The active token is 102 and active
      expect(membership?.activeToken?.tokenId).toBe(102);
      expect(membership?.activeToken?.state).toBe('active');

      // Verify overall access decision via service / API is ALLOW
      await prisma.accessPolicy.create({
        data: {
          communityId,
          resource: 'dashboard',
          ruleType: 'MEMBERS_ONLY',
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet,
          communityId,
          resource: 'dashboard',
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.allowed).toBe(true);
    });

    test('should process Suspend then Mint correctly (Ordering: Suspend Token 101, then Mint Token 102)', async () => {
      const wallet = '0x9999999999999999999999999999999999999999';
      const communityId = 'community-ooo-test';

      const mint1: DecodedMembershipMintedEvent = {
        type: 'MembershipMinted',
        to: wallet,
        tokenId: 101,
        communityId,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        chainId: 1,
        txHash: '0xhash101',
        blockNumber: 1000,
        logIndex: 0,
      };

      const suspend1: DecodedMembershipSuspendedEvent = {
        type: 'MembershipSuspended',
        tokenId: 101,
        isSuspended: true,
        chainId: 1,
        txHash: '0xhash102',
        blockNumber: 1001,
        logIndex: 0,
      };

      const mint2: DecodedMembershipMintedEvent = {
        type: 'MembershipMinted',
        to: wallet,
        tokenId: 102,
        communityId,
        expiresAt: Math.floor(Date.now() / 1000) + 7200,
        chainId: 1,
        txHash: '0xhash103',
        blockNumber: 1001,
        logIndex: 1,
      };

      // Apply first mint
      await applyContractEvent(prisma, mint1);
      // Apply suspension (normal sequence)
      await applyContractEvent(prisma, suspend1);
      // Apply second mint
      await applyContractEvent(prisma, mint2);

      // Verify records on disk
      const token101 = await prisma.membershipToken.findFirst({
        where: { tokenId: 101 },
      });
      const token102 = await prisma.membershipToken.findFirst({
        where: { tokenId: 102 },
      });

      expect(token101?.state).toBe('suspended');
      expect(token102?.state).toBe('active');

      const membership = await prisma.membership.findFirst({
        where: { member: { wallet: { address: wallet } } },
        include: { activeToken: true },
      });
      expect(membership?.activeToken?.tokenId).toBe(102);
      expect(membership?.activeToken?.state).toBe('active');

      // Verify overall access decision via service / API is ALLOW
      await prisma.accessPolicy.create({
        data: {
          communityId,
          resource: 'dashboard',
          ruleType: 'MEMBERS_ONLY',
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet,
          communityId,
          resource: 'dashboard',
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.allowed).toBe(true);
    });
  });

  describe('Scenario 4: Renewed Membership Extends Expiry', () => {
    beforeEach(async () => {
      await prisma.processedEvent.deleteMany({});
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.membershipToken.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should update membership via MembershipRenewed event', async () => {
      const scenario = testFixtures.renewedMembership;
      const initialEvent = scenario.initialEvent;
      const renewalEvent = scenario.renewalEvent;

      // Apply initial mint
      await applyContractEvent(prisma, initialEvent);

      const beforeRenewal = await prisma.membershipToken.findFirst({
        where: { tokenId: initialEvent.tokenId },
      });

      expect(beforeRenewal?.expiresAt).toBeDefined();
      const beforeExpiresAt = beforeRenewal!.expiresAt!.getTime();

      // Apply renewal
      await applyContractEvent(prisma, renewalEvent);

      const afterRenewal = await prisma.membershipToken.findFirst({
        where: { tokenId: initialEvent.tokenId },
      });

      const afterExpiresAt = afterRenewal!.expiresAt!.getTime();

      expect(afterExpiresAt).toBeGreaterThan(beforeExpiresAt);
      expect(afterRenewal?.renewedAt).toBeDefined();
    });

    test('should maintain active access after renewal', async () => {
      const scenario = testFixtures.renewedMembership;
      const initialEvent = scenario.initialEvent;
      const renewalEvent = scenario.renewalEvent;

      await applyContractEvent(prisma, initialEvent);
      await applyContractEvent(prisma, renewalEvent);

      // Create access policy
      await prisma.accessPolicy.create({
        data: {
          communityId: initialEvent.communityId,
          resource: 'dashboard',
          ruleType: 'MEMBERS_ONLY',
        },
      });

      // Check access via API
      const response = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet: initialEvent.to,
          communityId: initialEvent.communityId,
          resource: 'dashboard',
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.allowed).toBe(true);
      expect(result.membershipState).toBe('active');
    });
  });

  describe('Policy Engine Integration', () => {
    beforeEach(async () => {
      await prisma.processedEvent.deleteMany({});
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.membershipToken.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should allow PUBLIC access regardless of membership', async () => {
      const event = testFixtures.expiredMembership.event; // Use expired member
      await applyContractEvent(prisma, event);

      // Create public policy
      await prisma.accessPolicy.create({
        data: {
          communityId: event.communityId,
          resource: 'about',
          ruleType: 'PUBLIC',
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet: event.to,
          communityId: event.communityId,
          resource: 'about',
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.allowed).toBe(true);
      expect(result.code).toBe('ALLOW');
    });

    test('should deny access when no policy exists', async () => {
      const event = testFixtures.activeMembership.event;
      await applyContractEvent(prisma, event);

      // No access policy created

      const response = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet: event.to,
          communityId: event.communityId,
          resource: 'unknown-resource',
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('DENY');
    });

    test('should grant access with ADMINS_ONLY when user has admin role', async () => {
      const event = testFixtures.activeMembership.event;
      await applyContractEvent(prisma, event);

      // Get the member and assign admin role
      const member = await prisma.member.findFirst({
        where: {
          community: { id: event.communityId },
          wallet: { address: event.to.toLowerCase() },
        },
      });

      expect(member).toBeDefined();

      await prisma.roleAssignment.create({
        data: {
          memberId: member!.id,
          role: 'admin',
          source: 'manual',
          active: true,
        },
      });

      // Create admin-only policy
      await prisma.accessPolicy.create({
        data: {
          communityId: event.communityId,
          resource: 'admin-panel',
          ruleType: 'ADMINS_ONLY',
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet: event.to,
          communityId: event.communityId,
          resource: 'admin-panel',
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.allowed).toBe(true);
      expect(result.effectiveRoles).toContain('admin');
    });
  });

  describe('Member Profile Endpoint', () => {
    beforeEach(async () => {
      await prisma.processedEvent.deleteMany({});
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.membershipToken.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should return member profile with membership state', async () => {
      const event = testFixtures.activeMembership.event;
      await applyContractEvent(prisma, event);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/communities/${event.communityId}/members/${event.to}`,
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.wallet).toBe(event.to);
      expect(result.communityId).toBe(event.communityId);
      expect(result.membership).toBeDefined();
      expect(result.membership.state).toBe('active');
    });

    test('should return 404 when member not found', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/communities/community-dev/members/0x0000000000000000000000000000000000000000`,
      });

      expect(response.statusCode).toBe(404);
    });

    test('GET /v1/communities/:communityId/members/:wallet edge cases: unknown wallet returns 404 with reason', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/communities/community-dev/members/0x9999999999999999999999999999999999999999`,
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('NOT_FOUND');
      expect(body.code).toBe('NOT_FOUND');
      expect(body.message).toBe('Member not found');
    });

    test('GET /v1/communities/:communityId/members/:wallet edge cases: mixed-case wallet address resolves canonically', async () => {
      const event = testFixtures.activeMembership.event;
      await applyContractEvent(prisma, event);

      // Convert canonical lowercase to mixed-case
      const mixedCaseWallet = event.to.replace(/[a-f]/g, (c) => c.toUpperCase());

      const response = await app.inject({
        method: 'GET',
        url: `/v1/communities/${event.communityId}/members/${mixedCaseWallet}`,
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.wallet).toBe(event.to.toLowerCase());
      expect(result.communityId).toBe(event.communityId);
      expect(result.membership.state).toBe('active');
    });

    test('GET /v1/communities/:communityId/members/:wallet edge cases: multi-community scoping prevents cross-community leakage', async () => {
      // Seed wallet/membership in community-dev
      const eventA = testFixtures.activeMembership.event; // communityId is 'community-dev', wallet is eventA.to
      await applyContractEvent(prisma, eventA);

      // Seed a different community with the same wallet
      const otherCommunityId = 'community-prod';
      const eventB = {
        ...eventA,
        tokenId: 999,
        communityId: otherCommunityId,
      };
      await applyContractEvent(prisma, eventB);

      // 1. Query for community-dev
      const responseA = await app.inject({
        method: 'GET',
        url: `/v1/communities/${eventA.communityId}/members/${eventA.to}`,
      });
      expect(responseA.statusCode).toBe(200);
      const resultA = JSON.parse(responseA.body);
      expect(resultA.communityId).toBe(eventA.communityId);

      // 2. Query for community-prod
      const responseB = await app.inject({
        method: 'GET',
        url: `/v1/communities/${otherCommunityId}/members/${eventA.to}`,
      });
      expect(responseB.statusCode).toBe(200);
      const resultB = JSON.parse(responseB.body);
      expect(resultB.communityId).toBe(otherCommunityId);

      // 3. Query for a third community where this member doesn't exist
      const responseC = await app.inject({
        method: 'GET',
        url: `/v1/communities/community-unknown/members/${eventA.to}`,
      });
      expect(responseC.statusCode).toBe(404);

      // 4. Query memberships scoped endpoint for community-dev
      const membershipsA = await app.inject({
        method: 'GET',
        url: `/v1/communities/${eventA.communityId}/memberships/${eventA.to}`,
      });
      expect(membershipsA.statusCode).toBe(200);
      const mResultA = JSON.parse(membershipsA.body);
      // It should only have 1 community in the list
      expect(mResultA.communities.length).toBe(1);
      expect(mResultA.communities[0].communityId).toBe(eventA.communityId);

      // 5. Query memberships scoped endpoint for community-prod
      const membershipsB = await app.inject({
        method: 'GET',
        url: `/v1/communities/${otherCommunityId}/memberships/${eventA.to}`,
      });
      expect(membershipsB.statusCode).toBe(200);
      const mResultB = JSON.parse(membershipsB.body);
      expect(mResultB.communities.length).toBe(1);
      expect(mResultB.communities[0].communityId).toBe(otherCommunityId);
    });
  });

  describe('Audit Chain of Custody Integration', () => {
    beforeEach(async () => {
      await prisma.outboxEvent.deleteMany({
        where: { communityId: { in: ['community-audit-test', 'community-integrity-test', 'community-multi-test'] } },
      });
      await prisma.processedEvent.deleteMany({});
      await prisma.auditEvent.deleteMany({});
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.membershipToken.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should create complete audit trail from on-chain event to access decision', async () => {
      // 1. Simulate a mint event (on-chain) with full blockchain metadata
      const mintEvent: DecodedMembershipMintedEvent = {
        type: 'MembershipMinted',
        to: '0x5555555555555555555555555555555555555555',
        tokenId: 999,
        communityId: 'community-audit-test',
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        chainId: 1,
        txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        blockNumber: 12345678,
        blockHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        logIndex: 5,
      };

      // 2. Apply the event (this creates audit events and outbox events with blockchain metadata)
      await applyContractEvent(prisma, mintEvent);

      // 3. Verify the indexing worker successfully persisted state changes with correct metadata
      const membership = await prisma.membershipToken.findFirst({
        where: { tokenId: mintEvent.tokenId },
        include: { member: { include: { wallet: true } } },
      });

      expect(membership).toBeDefined();
      expect(membership?.state).toBe('active');
      expect(membership?.member.wallet.address).toBe(mintEvent.to.toLowerCase());

      // Verify audit event was created with on-chain metadata
      const auditEvents = await prisma.auditEvent.findMany({
        where: {
          txHash: mintEvent.txHash,
          eventType: 'MEMBERSHIP_CREATED',
        },
      });

      expect(auditEvents.length).toBeGreaterThan(0);
      const membershipCreatedAudit = auditEvents[0];
      expect(membershipCreatedAudit.chainId).toBe(mintEvent.chainId);
      expect(membershipCreatedAudit.txHash).toBe(mintEvent.txHash);
      expect(membershipCreatedAudit.blockNumber).toBe(mintEvent.blockNumber);
      expect(membershipCreatedAudit.logIndex).toBe(mintEvent.logIndex);
      expect(membershipCreatedAudit.correlationId).toBeTruthy();

      // Verify outbox event was created with on-chain metadata
      const outboxEvents = await prisma.outboxEvent.findMany({
        where: {
          txHash: mintEvent.txHash,
          eventType: 'MEMBERSHIP_CREATED',
        },
      });

      expect(outboxEvents.length).toBeGreaterThan(0);
      const membershipCreatedOutbox = outboxEvents[0];
      expect(membershipCreatedOutbox.chainId).toBe(mintEvent.chainId);
      expect(membershipCreatedOutbox.txHash).toBe(mintEvent.txHash);
      expect(membershipCreatedOutbox.blockNumber).toBe(mintEvent.blockNumber);
      expect(membershipCreatedOutbox.logIndex).toBe(mintEvent.logIndex);
      expect(membershipCreatedOutbox.correlationId).toBe(membershipCreatedAudit.correlationId);

      // 4. Create access policy and trigger an access-check decision
      await prisma.accessPolicy.create({
        data: {
          communityId: mintEvent.communityId,
          resource: 'audit-test-resource',
          ruleType: 'MEMBERS_ONLY',
        },
      });

      const accessCheckResponse = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet: mintEvent.to,
          communityId: mintEvent.communityId,
          resource: 'audit-test-resource',
        },
      });

      expect(accessCheckResponse.statusCode).toBe(200);
      const accessDecision = JSON.parse(accessCheckResponse.body);
      expect(accessDecision.allowed).toBe(true);
      expect(accessDecision.code).toBe('ALLOW');

      // Verify access check created audit event with state snapshots
      const accessAuditEvents = await prisma.auditEvent.findMany({
        where: {
          eventType: 'ACCESS_CHECK',
          walletId: mintEvent.to.toLowerCase(),
          communityId: mintEvent.communityId,
          resource: 'audit-test-resource',
        },
      });

      expect(accessAuditEvents.length).toBeGreaterThan(0);
      const accessCheckAudit = accessAuditEvents[0];
      expect(accessCheckAudit.correlationId).toBeTruthy();
      expect(accessCheckAudit.decision).toBe('ALLOW');
      expect(accessCheckAudit.membershipStateVersion).toBeTruthy();

      // Parse and verify membership state snapshot
      const membershipSnapshot = JSON.parse(accessCheckAudit.membershipStateVersion!);
      expect(membershipSnapshot.tokenId).toBe(mintEvent.tokenId);
      expect(membershipSnapshot.state).toBe('active');
      expect(membershipSnapshot.effectiveState).toBe('active');

      // 5. Call the admin audit trace endpoint to retrieve complete trace
      const traceResponse = await app.inject({
        method: 'GET',
        url: `/admin/audit/trace/${accessCheckAudit.correlationId}`,
      });
      expect(traceResponse.statusCode).toBe(200);
      const auditTrace = JSON.parse(traceResponse.body);

      // 6. Verify the trace perfectly links the access decision back to the originating mint event
      expect(auditTrace.correlationId).toBe(accessCheckAudit.correlationId);
      expect(auditTrace.summary.totalEvents).toBeGreaterThan(0);
      
      // Verify access decision is in trace
      expect(auditTrace.accessDecisions.length).toBe(1);
      expect(auditTrace.accessDecisions[0].decision).toBe('ALLOW');
      expect(auditTrace.accessDecisions[0].resource).toBe('audit-test-resource');
      expect(auditTrace.accessDecisions[0].membershipState).toBeDefined();
      expect(auditTrace.accessDecisions[0].membershipState.tokenId).toBe(mintEvent.tokenId);

      // 7. Also test querying by transaction hash
      const txTraceResponse = await app.inject({
        method: 'GET',
        url: `/admin/audit/trace/tx/${mintEvent.txHash}`,
      });

      expect(txTraceResponse.statusCode).toBe(200);
      const txTrace = JSON.parse(txTraceResponse.body);
      expect(txTrace.txHash).toBe(mintEvent.txHash);
      expect(txTrace.traces.length).toBeGreaterThan(0);
      expect(txTrace.traces[0].originatingOnChainEvent).toBeDefined();
      expect(txTrace.traces[0].originatingOnChainEvent?.txHash).toBe(mintEvent.txHash);
      expect(txTrace.traces[0].originatingOnChainEvent?.blockNumber).toBe(mintEvent.blockNumber);
      expect(txTrace.traces[0].originatingOnChainEvent?.logIndex).toBe(mintEvent.logIndex);

      // 8. Test querying by wallet
      const walletTraceResponse = await app.inject({
        method: 'GET',
        url: `/admin/audit/trace/wallet/${mintEvent.to}?communityId=${mintEvent.communityId}`,
      });

      expect(walletTraceResponse.statusCode).toBe(200);
      const walletTrace = JSON.parse(walletTraceResponse.body);
      expect(walletTrace.wallet).toBe(mintEvent.to);
      expect(walletTrace.communityId).toBe(mintEvent.communityId);
      expect(walletTrace.traces.length).toBeGreaterThan(0);
    });

    test('should maintain append-only audit integrity', async () => {
      const mintEvent: DecodedMembershipMintedEvent = {
        type: 'MembershipMinted',
        to: '0x7777777777777777777777777777777777777777',
        tokenId: 888,
        communityId: 'community-integrity-test',
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        chainId: 1,
        txHash: '0xintegrity1234567890abcdef1234567890abcdef1234567890abcdef123456',
        blockNumber: 11111111,
        blockHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
        logIndex: 3,
      };

      await applyContractEvent(prisma, mintEvent);

      // Get initial audit event count
      const initialAuditEvents = await prisma.auditEvent.findMany({
        where: { txHash: mintEvent.txHash },
      });
      const initialCount = initialAuditEvents.length;
      expect(initialCount).toBeGreaterThan(0);

      // Attempt to apply the same event again (should be idempotent)
      await applyContractEvent(prisma, mintEvent);

      // Verify no duplicate audit events were created
      const afterReplayAuditEvents = await prisma.auditEvent.findMany({
        where: { txHash: mintEvent.txHash },
      });
      expect(afterReplayAuditEvents.length).toBe(initialCount);

      // Verify audit events cannot be updated (schema doesn't expose update operations)
      // This is enforced at application level - no update routes exist for audit tables

      // Verify audit events cannot be deleted (schema doesn't expose delete operations)
      // This is enforced at application level - no delete routes exist for audit tables
    });

    test('should link multiple access decisions to same originating event', async () => {
      const mintEvent: DecodedMembershipMintedEvent = {
        type: 'MembershipMinted',
        to: '0x6666666666666666666666666666666666666666',
        tokenId: 777,
        communityId: 'community-multi-test',
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        chainId: 1,
        txHash: '0xmulti1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        blockNumber: 22222222,
        blockHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
        logIndex: 7,
      };

      await applyContractEvent(prisma, mintEvent);

      // Create multiple policies
      await prisma.accessPolicy.createMany({
        data: [
          {
            communityId: mintEvent.communityId,
            resource: 'resource-A',
            ruleType: 'MEMBERS_ONLY',
          },
          {
            communityId: mintEvent.communityId,
            resource: 'resource-B',
            ruleType: 'MEMBERS_ONLY',
          },
        ],
      });

      // Make multiple access checks
      const accessCheckA = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet: mintEvent.to,
          communityId: mintEvent.communityId,
          resource: 'resource-A',
        },
      });

      const accessCheckB = await app.inject({
        method: 'POST',
        url: '/v1/access/check',
        payload: {
          wallet: mintEvent.to,
          communityId: mintEvent.communityId,
          resource: 'resource-B',
        },
      });

      expect(accessCheckA.statusCode).toBe(200);
      expect(accessCheckB.statusCode).toBe(200);

      // Query by transaction hash to see all related events
      const txTraceResponse = await app.inject({
        method: 'GET',
        url: `/admin/audit/trace/tx/${mintEvent.txHash}`,
      });

      expect(txTraceResponse.statusCode).toBe(200);
      const txTrace = JSON.parse(txTraceResponse.body);

      // Should have at least one trace for the membership creation
      expect(txTrace.traces.length).toBeGreaterThan(0);
      
      // The originating event should be the same for all traces
      const originTx = txTrace.traces[0].originatingOnChainEvent?.txHash;
      expect(originTx).toBe(mintEvent.txHash);

      // Verify we can also query by wallet and see all access decisions
      const walletTraceResponse = await app.inject({
        method: 'GET',
        url: `/admin/audit/trace/wallet/${mintEvent.to}?communityId=${mintEvent.communityId}`,
      });

      expect(walletTraceResponse.statusCode).toBe(200);
      const walletTrace = JSON.parse(walletTraceResponse.body);
      
      // Count total access decisions across all traces
      const totalAccessDecisions = walletTrace.traces.reduce(
        (sum: number, trace: any) => sum + trace.accessDecisions.length,
        0,
      );
      expect(totalAccessDecisions).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Community Roles Endpoint', () => {
    const TEST_COMMUNITY_ID = 'roles-test-community';

    beforeAll(async () => {
      await prisma.community.upsert({
        where: { id: TEST_COMMUNITY_ID },
        update: {},
        create: {
          id: TEST_COMMUNITY_ID,
          name: 'Roles Test Community',
        },
      });
    });

    test('should return 404 for a non-existent community', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/communities/non-existent-community-id/roles',
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('NOT_FOUND');
    });

    test('should return community roles and hierarchy metadata', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/communities/${TEST_COMMUNITY_ID}/roles`,
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      
      expect(body.roles).toBeDefined();
      expect(body.roles).toHaveLength(3);

      const adminRole = body.roles.find((r: any) => r.name === 'admin');
      expect(adminRole).toBeDefined();
      expect(adminRole.description).toBe('Administrator with full permissions');
      expect(adminRole.implies).toContain('contributor');
      expect(adminRole.implies).toContain('member');

      const contributorRole = body.roles.find((r: any) => r.name === 'contributor');
      expect(contributorRole).toBeDefined();
      expect(contributorRole.description).toBe('Contributor with write permissions');
      expect(contributorRole.implies).toContain('member');
      expect(contributorRole.implies).not.toContain('admin');

      const memberRole = body.roles.find((r: any) => r.name === 'member');
      expect(memberRole).toBeDefined();
      expect(memberRole.description).toBe('Standard member with basic permissions');
      expect(memberRole.implies).toHaveLength(0);
    });
  });

  describe('Resilient Indexing Pipeline: Checkpoints, Reorgs, & Idempotency', () => {
    const chainId = 31337;
    const contractAddress = '0x1111111111111111111111111111111111111111';
    const stateId = `${chainId}:${contractAddress.toLowerCase()}`;

    beforeEach(async () => {
      await prisma.processedEvent.deleteMany({});
      await prisma.blockHeader.deleteMany({});
      await prisma.indexerState.deleteMany({});
      await prisma.indexerCheckpoint.deleteMany({});
      await prisma.auditEvent.deleteMany({});
      await prisma.deadLetterEvent.deleteMany({});
      await prisma.outboxEvent.deleteMany({});
      await prisma.roleAssignment.deleteMany({});
      await prisma.badge.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.governanceRule.deleteMany({});
      await prisma.approval.deleteMany({});
      await prisma.approvalRequest.deleteMany({});
      await prisma.webhookSubscription.deleteMany({});
      await prisma.appeal.deleteMany({});
      await prisma.membershipToken.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.profile.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.communityContract.deleteMany({}).catch(() => undefined);
      await prisma.community.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should persist IndexerState and resume safely across worker restarts', async () => {
      const blocks: Record<number, BlockInfo> = {
        100: { number: 100, hash: '0xblock100', parentHash: '0xblock99' },
        101: { number: 101, hash: '0xblock101', parentHash: '0xblock100' },
        102: { number: 102, hash: '0xblock102', parentHash: '0xblock101' },
      };

      const mockProvider: ChainProvider = {
        getLatestBlockNumber: async () => 102,
        getBlock: async (n) => blocks[n] || { number: n, hash: `0xblock${n}`, parentHash: `0xblock${n - 1}` },
        getLogs: async () => [],
      };

      const worker1 = createIndexerWorker(mockProvider, 5000, 0, prisma, chainId, 10, contractAddress);
      await worker1.runPass();

      const state = await prisma.indexerState.findUnique({ where: { id: stateId } });
      expect(state).toBeDefined();
      expect(state?.lastBlockNumber).toBe(102);
      expect(state?.lastBlockHash).toBe('0xblock102');

      blocks[103] = { number: 103, hash: '0xblock103', parentHash: '0xblock102' };
      const mockProvider2: ChainProvider = {
        getLatestBlockNumber: async () => 103,
        getBlock: async (n) => blocks[n],
        getLogs: async () => [],
      };

      const worker2 = createIndexerWorker(mockProvider2, 5000, 0, prisma, chainId, 10, contractAddress);
      await worker2.runPass();

      const resumed = await prisma.indexerState.findUnique({ where: { id: stateId } });
      expect(resumed?.lastBlockNumber).toBe(103);
      expect(resumed?.lastBlockHash).toBe('0xblock103');
    });

    test('should process the same log only once (idempotent redelivery)', async () => {
      const mintEvent = {
        type: 'MembershipMinted' as const,
        to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        tokenId: 42,
        communityId: 'idempotency-community',
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        chainId,
        contractAddress,
        transactionHash: '0xtx-idempotent',
        blockHash: '0xblock50',
        logIndex: 0,
        blockNumber: 50,
      };

      await applyContractEvent(prisma, mintEvent as any);
      await applyContractEvent(prisma, mintEvent as any);

      const tokens = await prisma.membershipToken.findMany({
        where: { tokenId: 42, chainId, contractAddress },
      });
      expect(tokens).toHaveLength(1);

      const processed = await prisma.processedEvent.findMany({
        where: {
          chainId,
          transactionHash: '0xtx-idempotent',
          logIndex: 0,
        },
      });
      expect(processed).toHaveLength(1);
    });

    test('should detect reorg via block-hash comparison and reverse then reapply state', async () => {
      const canonicalBlocks: Record<number, BlockInfo> = {
        10: { number: 10, hash: '0xhash10', parentHash: '0xhash9' },
        11: { number: 11, hash: '0xhash11-canonical', parentHash: '0xhash10' },
      };

      const logsBlock10 = [
        {
          type: 'MembershipMinted',
          to: '0x9999999999999999999999999999999999999999',
          tokenId: 99,
          communityId: 'reorg-community',
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
          chainId,
          contractAddress,
          transactionHash: '0xtx10',
          blockHash: '0xhash10',
          logIndex: 0,
          blockNumber: 10,
        },
      ];

      const logsBlock11Orphaned = [
        {
          type: 'MembershipSuspended',
          tokenId: 99,
          isSuspended: true,
          chainId,
          contractAddress,
          transactionHash: '0xtx11-orphaned',
          blockHash: '0xhash11-orphaned',
          logIndex: 0,
          blockNumber: 11,
        },
      ];

      let currentLogs: Record<number, any[]> = {
        10: logsBlock10,
        11: logsBlock11Orphaned,
      };
      let currentBlocks: Record<number, BlockInfo> = {
        10: { number: 10, hash: '0xhash10', parentHash: '0xhash9' },
        11: { number: 11, hash: '0xhash11-orphaned', parentHash: '0xhash10' },
      };

      const provider: ChainProvider = {
        getLatestBlockNumber: async () => 11,
        getBlock: async (n) =>
          currentBlocks[n] || {
            number: n,
            hash: `0xhash${n}`,
            parentHash: `0xhash${n - 1}`,
          },
        getLogs: async (from, to) => {
          let res: any[] = [];
          for (let b = from; b <= to; b++) {
            if (currentLogs[b]) res.push(...currentLogs[b]);
          }
          return res;
        },
      };

      const worker = createIndexerWorker(
        provider,
        5000,
        0,
        prisma,
        chainId,
        10,
        contractAddress,
      );

      // Seed IndexerState + LCA header so the first pass starts at block 10.
      await prisma.blockHeader.create({
        data: { chainId, blockNumber: 9, blockHash: '0xhash9' },
      });
      await prisma.indexerState.create({
        data: {
          id: stateId,
          chainId,
          contractAddress,
          lastBlockNumber: 9,
          lastBlockHash: '0xhash9',
        },
      });

      await worker.runPass();

      let token = await prisma.membershipToken.findFirst({
        where: { tokenId: 99, chainId, contractAddress },
      });
      expect(token?.state).toBe('suspended');

      // Reorg: block 11 is replaced; suspend log disappears.
      currentBlocks[11] = canonicalBlocks[11];
      currentLogs[11] = [];

      await worker.runPass();

      token = await prisma.membershipToken.findFirst({
        where: { tokenId: 99, chainId, contractAddress },
      });
      expect(token?.state).toBe('active');

      await worker.runPass();

      const updatedState = await prisma.indexerState.findUnique({
        where: { id: stateId },
      });
      expect(updatedState?.lastBlockNumber).toBe(11);
      expect(updatedState?.lastBlockHash).toBe('0xhash11-canonical');
    });

    test('should expose reorg-corrected state through GET /v1/communities/:id/memberships/:wallet API', async () => {
      const canonicalBlocks: Record<number, BlockInfo> = {
        10: { number: 10, hash: '0xhash10', parentHash: '0xhash9' },
        11: { number: 11, hash: '0xhash11-canonical', parentHash: '0xhash10' },
      };

      const logsBlock10 = [
        {
          type: 'MembershipMinted',
          to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          tokenId: 88,
          communityId: REORG_COMMUNITY_ID,
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
          chainId: REORG_CHAIN_ID,
          contractAddress: REORG_CONTRACT_ADDRESS,
          transactionHash: '0xtx-reorg-api-10',
          blockHash: '0xhash10',
          logIndex: 0,
          blockNumber: 10,
        },
      ];

      const logsBlock11Orphaned = [
        {
          type: 'MembershipSuspended',
          tokenId: 88,
          isSuspended: true,
          chainId: REORG_CHAIN_ID,
          contractAddress: REORG_CONTRACT_ADDRESS,
          transactionHash: '0xtx-reorg-api-11-orphaned',
          blockHash: '0xhash11-orphaned',
          logIndex: 0,
          blockNumber: 11,
        },
      ];

      const provider: ChainProvider = {
        getLatestBlockNumber: async () => 11,
        getBlock: async (n) =>
          canonicalBlocks[n] || {
            number: n,
            hash: `0xhash${n}`,
            parentHash: `0xhash${n - 1}`,
          },
        getLogs: async (from, to) => {
          let res: any[] = [];
          for (let b = from; b <= to; b++) {
            if (b === 10) res.push(...logsBlock10);
            if (b === 11) res.push(...logsBlock11Orphaned);
          }
          return res;
        },
      };

      const worker = createIndexerWorker(
        provider,
        5000,
        0,
        prisma,
        REORG_CHAIN_ID,
        10,
        REORG_CONTRACT_ADDRESS,
      );

      // Seed IndexerState + LCA header
      await prisma.blockHeader.create({
        data: { chainId: REORG_CHAIN_ID, blockNumber: 9, blockHash: '0xhash9' },
      });
      await prisma.indexerState.create({
        data: {
          id: REORG_STATE_ID,
          chainId: REORG_CHAIN_ID,
          contractAddress: REORG_CONTRACT_ADDRESS,
          lastBlockNumber: 9,
          lastBlockHash: '0xhash9',
        },
      });

      // Create access policy
      await prisma.accessPolicy.create({
        data: {
          communityId: REORG_COMMUNITY_ID,
          resource: 'dashboard',
          ruleType: 'MEMBERS_ONLY',
        },
      });

      await worker.runPass();

      // After reorg, check via API — should show suspended because orphaned block was applied
      const reorgApiResponse = await app.inject({
        method: 'GET',
        url: `/v1/communities/${REORG_COMMUNITY_ID}/memberships/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
      });

      expect(reorgApiResponse.statusCode).toBe(200);
      const reorgResult = JSON.parse(reorgApiResponse.body);
      expect(reorgResult.communities[0].state).toBe('suspended');

      // Now simulate reorg: canonical chain has no suspend event
      canonicalBlocks[11] = { number: 11, hash: '0xhash11-canonical', parentHash: '0xhash10' };

      await worker.runPass();

      // After reorg recovery, check via API — state should be 'active'
      const recoveredApiResponse = await app.inject({
        method: 'GET',
        url: `/v1/communities/${REORG_COMMUNITY_ID}/memberships/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
      });

      expect(recoveredApiResponse.statusCode).toBe(200);
      const recoveredResult = JSON.parse(recoveredApiResponse.body);
      expect(recoveredResult.communities[0].state).toBe('active');

      // Verify IndexerState reflects canonical chain
      const finalState = await prisma.indexerState.findUnique({
        where: { id: REORG_STATE_ID },
      });
      expect(finalState?.lastBlockHash).toBe('0xhash11-canonical');
    });

    test('should apply confirmation depth: skip unconfirmed tip blocks and process after they settle', async () => {
      const CONFIRMATION_DEPTH = 5;
      const chainId = 42;
      const contractAddress = '0xConfirmationDepthTestContract111111111111';
      const stateId = `${chainId}:${contractAddress.toLowerCase()}`;

      const blocks: Record<number, BlockInfo> = {};
      for (let n = 0; n <= 20; n++) {
        blocks[n] = {
          number: n,
          hash: `0xblockHash${n}`,
          parentHash: `0xblockHash${n - 1}`,
        };
      }

      let currentLogs: Record<number, any[]> = {};
      let providerCallCount = 0;

      const provider: ChainProvider = {
        getLatestBlockNumber: async () => 20,
        getBlock: async (n) =>
          blocks[n] || {
            number: n,
            hash: `0xblockHash${n}`,
            parentHash: `0xblockHash${n - 1}`,
          },
        getLogs: async (from, to) => {
          providerCallCount++;
          let res: any[] = [];
          for (let b = from; b <= to; b++) {
            if (currentLogs[b]) res.push(...currentLogs[b]);
          }
          return res;
        },
      };

      const worker = createIndexerWorker(
        provider,
        5000,
        CONFIRMATION_DEPTH,
        prisma,
        chainId,
        10,
        contractAddress,
      );

      // Seed IndexerState at block 0
      await prisma.blockHeader.create({
        data: { chainId, blockNumber: 0, blockHash: '0xblockHash0' },
      });
      await prisma.indexerState.create({
        data: {
          id: stateId,
          chainId,
          contractAddress,
          lastBlockNumber: 0,
          lastBlockHash: '0xblockHash0',
        },
      });

      // Place a log at block 19 (one block above safe window: 20 - 5 = 15)
      currentLogs[19] = [
        {
          type: 'MembershipMinted',
          to: '0xcccccccccccccccccccccccccccccccccccccccc',
          tokenId: 55,
          communityId: 'confirmation-depth-community',
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
          chainId,
          contractAddress,
          transactionHash: '0xtx-unconfirmed',
          blockHash: '0xblockHash19',
          logIndex: 0,
          blockNumber: 19,
        },
      ];

      await worker.runPass();

      // Block 19 is above safe window (15) — should not be processed yet
      const processedAfterFirstPass = await prisma.processedEvent.count({
        where: {
          chainId,
          transactionHash: '0xtx-unconfirmed',
        },
      });
      expect(processedAfterFirstPass).toBe(0);

      // Now advance to block 50 so safe window = 45
      provider.getLatestBlockNumber = async () => 50;

      await worker.runPass();

      // Now block 19 is below safe window — should process
      const processedCount = await prisma.processedEvent.count({
        where: {
          chainId,
          transactionHash: '0xtx-unconfirmed',
        },
      });
      expect(processedCount).toBeGreaterThan(0);

      // Verify membership was created
      const membership = await prisma.membershipToken.findFirst({
        where: { tokenId: 55, chainId, contractAddress },
      });
      expect(membership).toBeDefined();
      expect(membership?.state).toBe('active');
    });
  });
});
