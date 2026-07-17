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

/**
 * Test Fixtures - Contract events that would be emitted by MembershipNFT
 */

const testFixtures = {
  // Scenario 1: Active membership with valid expiry
  activeMembership: {
    event: {
      type: 'MembershipMinted',
      to: '0xalice123456789abcdef1234567890abcdef',
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
      to: '0xbob123456789abcdef1234567890abcdef',
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
      to: '0xcarol123456789abcdef1234567890abc',
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
      to: '0xdave123456789abcdef1234567890abcde',
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
    await prisma.roleAssignment.deleteMany({});
    await prisma.badge.deleteMany({});
    await prisma.membership.deleteMany({});
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
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should create active membership from MembershipMinted event', async () => {
      const event = testFixtures.activeMembership.event;

      // Apply event to database
      await applyContractEvent(prisma, event);

      // Verify membership was created
      const membership = await prisma.membership.findUnique({
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
        url: `/v1/memberships/${event.to}`,
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
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should create expired membership from past expiresAt', async () => {
      const event = testFixtures.expiredMembership.event;
      await applyContractEvent(prisma, event);

      const membership = await prisma.membership.findUnique({
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
        url: `/v1/memberships/${event.to}`,
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.communities[0].state).toBe('expired');
    });
  });

  describe('Scenario 3: Suspended Membership Denies Access', () => {
    beforeEach(async () => {
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should apply suspension via MembershipSuspended event', async () => {
      const event = testFixtures.suspendedMembership.event;
      const suspendedEvent = testFixtures.suspendedMembership.suspendedEvent;

      await applyContractEvent(prisma, event);
      await applyContractEvent(prisma, suspendedEvent);

      const membership = await prisma.membership.findUnique({
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

    test('should report suspended state in memberships list', async () => {
      const event = testFixtures.suspendedMembership.event;
      const suspendedEvent = testFixtures.suspendedMembership.suspendedEvent;

      await applyContractEvent(prisma, event);
      await applyContractEvent(prisma, suspendedEvent);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/memberships/${event.to}`,
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body);
      expect(result.communities[0].state).toBe('suspended');
    });
  });

  describe('Scenario 4: Renewed Membership Extends Expiry', () => {
    beforeEach(async () => {
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
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

      const beforeRenewal = await prisma.membership.findUnique({
        where: { tokenId: initialEvent.tokenId },
      });

      expect(beforeRenewal?.expiresAt).toBeDefined();
      const beforeExpiresAt = beforeRenewal!.expiresAt!.getTime();

      // Apply renewal
      await applyContractEvent(prisma, renewalEvent);

      const afterRenewal = await prisma.membership.findUnique({
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
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
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
      await prisma.roleAssignment.deleteMany({});
      await prisma.membership.deleteMany({});
      await prisma.member.deleteMany({});
      await prisma.accessPolicy.deleteMany({});
      await prisma.wallet.deleteMany({});
    });

    test('should return member profile with membership state', async () => {
      const event = testFixtures.activeMembership.event;
      await applyContractEvent(prisma, event);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/members/${event.to}`,
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
        url: '/v1/members/0xunknownwallet123456789abcdef',
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
