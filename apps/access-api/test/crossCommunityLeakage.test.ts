import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { registerRoutes } from '../src/routes';
import {
  applyContractEvent,
  getCurrentMembershipState,
  type DecodedMembershipMintedEvent,
  type DecodedMembershipRenewedEvent,
} from '../src/services/contractEventHelpers';
import { accessDecisionCacheKey } from '../src/services/memberService';
import { getResourceService } from '../src/services/resourceService';

// Audit-chain persistence is covered separately and is not part of scoping behavior.
jest.mock('../src/services/auditChainHasher', () => ({
  writeChainedAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

/**
 * Cross-community scoping safeguards.
 */

describe('Cross-community leakage safeguards', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;

  const wallet = '0x1111111111111111111111111111111111111111';
  const communityA = 'community-A';
  const communityB = 'community-B';
  const resource = 'shared-resource';

  async function mintMembership(communityId: string, tokenId: number) {
    const event: DecodedMembershipMintedEvent = {
      type: 'MembershipMinted',
      to: wallet,
      tokenId,
      communityId,
      expiresAt: Math.floor(Date.now() / 1000) + 60 * 60,
    };

    await applyContractEvent(prisma, event);
  }

  async function getMember(communityId: string) {
    const member = await prisma.member.findFirst({
      where: { communityId, wallet: { address: wallet } },
      include: { membership: true },
    });
    if (!member) throw new Error(`Missing test member for ${communityId}`);
    return member;
  }

  async function checkAccess(communityId: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/access/check',
      payload: { wallet, communityId, resource },
    });
    expect(response.statusCode).toBe(200);
    return JSON.parse(response.body);
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    app = Fastify({ logger: false });
    await registerRoutes(app);
  });

  beforeEach(async () => {
    await prisma.roleAssignment.deleteMany({});
    await prisma.membership.deleteMany({});
    await prisma.member.deleteMany({});
    await prisma.accessOverride.deleteMany({});
    await prisma.accessPolicy.deleteMany({});
    await prisma.resource.deleteMany({});
    await prisma.wallet.deleteMany({});
    await prisma.profile.deleteMany({});
    await prisma.community.deleteMany({});
    await prisma.auditEvent.deleteMany({});
    await prisma.outboxEvent.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('member reads', () => {
    test('membership responses contain only the requested community', async () => {
      await mintMembership(communityA, 101);
      await mintMembership(communityB, 202);

      for (const communityId of [communityA, communityB]) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/communities/${communityId}/memberships/${wallet}`,
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.communities).toEqual([
          expect.objectContaining({ communityId }),
        ]);
      }
    });

    test('profile roles from one community are not returned for another', async () => {
      await mintMembership(communityA, 101);
      await mintMembership(communityB, 202);
      const memberA = await getMember(communityA);
      await prisma.roleAssignment.create({
        data: { memberId: memberA.id, role: 'admin', source: 'manual' },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/communities/${communityB}/members/${wallet}`,
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(
        expect.objectContaining({ communityId: communityB, roles: [] }),
      );
    });
  });

  describe('access decisions', () => {
    test('membership state is resolved within the requested community', async () => {
      await mintMembership(communityA, 101);
      await mintMembership(communityB, 202);
      const memberB = await getMember(communityB);
      await prisma.membership.update({
        where: { memberId: memberB.id },
        data: { state: 'suspended' },
      });
      await prisma.accessPolicy.createMany({
        data: [communityA, communityB].map((communityId) => ({
          communityId,
          resource,
          ruleType: 'MEMBERS_ONLY',
        })),
      });

      expect((await checkAccess(communityA)).allowed).toBe(true);
      const decisionB = await checkAccess(communityB);
      expect(decisionB.allowed).toBe(false);
      expect(decisionB.membershipState).toBe('suspended');
    });

    test('roles assigned in one community do not grant access in another', async () => {
      await mintMembership(communityA, 101);
      await mintMembership(communityB, 202);
      const memberA = await getMember(communityA);
      await prisma.roleAssignment.create({
        data: { memberId: memberA.id, role: 'admin', source: 'manual' },
      });
      await prisma.accessPolicy.createMany({
        data: [communityA, communityB].map((communityId) => ({
          communityId,
          resource,
          ruleType: 'ADMINS_ONLY',
        })),
      });

      expect((await checkAccess(communityA)).allowed).toBe(true);
      const decisionB = await checkAccess(communityB);
      expect(decisionB.allowed).toBe(false);
      expect(decisionB.effectiveRoles).not.toContain('admin');
    });

    test('a policy in one community is not evaluated for another', async () => {
      await mintMembership(communityA, 101);
      await mintMembership(communityB, 202);
      const [memberA, memberB] = await Promise.all([
        getMember(communityA),
        getMember(communityB),
      ]);
      await prisma.membership.updateMany({
        where: { memberId: { in: [memberA.id, memberB.id] } },
        data: { state: 'suspended' },
      });
      await prisma.accessPolicy.createMany({
        data: [
          { communityId: communityA, resource, ruleType: 'PUBLIC' },
          { communityId: communityB, resource, ruleType: 'ADMINS_ONLY' },
        ],
      });

      expect((await checkAccess(communityA)).allowed).toBe(true);
      const decisionB = await checkAccess(communityB);
      expect(decisionB.allowed).toBe(false);
      expect(decisionB.reasons).toContainEqual(
        expect.objectContaining({ code: 'NEEDS_ADMIN' }),
      );
    });

    test('an ALLOW override cannot cross a community boundary', async () => {
      await mintMembership(communityA, 101);
      await mintMembership(communityB, 202);
      const [memberA, memberB] = await Promise.all([
        getMember(communityA),
        getMember(communityB),
      ]);
      await prisma.membership.updateMany({
        where: { memberId: { in: [memberA.id, memberB.id] } },
        data: { state: 'suspended' },
      });
      await prisma.accessPolicy.createMany({
        data: [communityA, communityB].map((communityId) => ({
          communityId,
          resource,
          ruleType: 'MEMBERS_ONLY',
        })),
      });
      await prisma.accessOverride.create({
        data: {
          communityId: communityA,
          wallet,
          resource,
          effect: 'ALLOW',
        },
      });

      expect((await checkAccess(communityA)).allowed).toBe(true);
      const decisionB = await checkAccess(communityB);
      expect(decisionB.allowed).toBe(false);
      expect(decisionB.reasons).not.toContainEqual(
        expect.objectContaining({ code: 'OVERRIDE_ALLOW' }),
      );
    });

    test('cache keys differ when only the community changes', () => {
      const common = {
        wallet,
        resource,
        membershipVersion: 1,
        roleVersion: 1,
        policyVersion: 1,
        resourceVersion: 1,
        overrideVersion: 1,
      };

      const keyA = accessDecisionCacheKey({ communityId: communityA, ...common });
      const keyB = accessDecisionCacheKey({ communityId: communityB, ...common });

      expect(keyA).not.toBe(keyB);
      expect(keyA).toContain(`c:${communityA}`);
      expect(keyB).toContain(`c:${communityB}`);
    });
  });

  describe('resource service', () => {
    test('same resource IDs are read independently per community', async () => {
      await mintMembership(communityA, 101);
      await mintMembership(communityB, 202);
      await prisma.resource.createMany({
        data: [
          { communityId: communityA, resourceId: resource, name: 'A resource' },
          {
            communityId: communityB,
            resourceId: resource,
            name: 'B resource',
            archived: true,
          },
        ],
      });
      const service = getResourceService(prisma);

      await expect(service.listResources(communityA)).resolves.toEqual({
        communityId: communityA,
        resources: [expect.objectContaining({ name: 'A resource' })],
      });
      await expect(service.isResourceActive(communityA, resource)).resolves.toBe(true);
      await expect(service.isResourceActive(communityB, resource)).resolves.toBe(false);
    });

    test('an admin from another community cannot mutate a resource', async () => {
      await mintMembership(communityA, 101);
      await prisma.community.create({ data: { id: communityB, name: 'Community B' } });
      const memberA = await getMember(communityA);
      await prisma.roleAssignment.create({
        data: { memberId: memberA.id, role: 'admin', source: 'manual' },
      });
      await prisma.resource.create({
        data: { communityId: communityB, resourceId: resource, name: 'B resource' },
      });
      const service = getResourceService(prisma);

      await expect(
        service.updateResource({
          requesterWallet: wallet,
          communityId: communityB,
          resourceId: resource,
          name: 'leaked update',
        }),
      ).rejects.toEqual(expect.objectContaining({ statusCode: 403 }));
      await expect(service.listResources(communityB)).resolves.toEqual({
        communityId: communityB,
        resources: [expect.objectContaining({ name: 'B resource' })],
      });
    });
  });

  describe('contract event helpers', () => {
    test('membership helpers and renewal events preserve community isolation', async () => {
      await mintMembership(communityA, 101);
      await mintMembership(communityB, 202);
      const beforeB = await getCurrentMembershipState(prisma, wallet, communityB);
      const newExpiry = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
      const renewal: DecodedMembershipRenewedEvent = {
        type: 'MembershipRenewed',
        tokenId: 101,
        newExpiresAt: newExpiry,
      };

      await applyContractEvent(prisma, renewal);

      const stateA = await getCurrentMembershipState(prisma, wallet, communityA);
      const stateB = await getCurrentMembershipState(prisma, wallet, communityB);
      expect(stateA?.tokenId).toBe(101);
      expect(stateA?.expiresAt?.getTime()).toBe(newExpiry * 1000);
      expect(stateB).toEqual(beforeB);
      expect(stateB?.tokenId).toBe(202);
    });
  });
});
