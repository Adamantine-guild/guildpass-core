import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { registerRoutes } from '../src/routes';
import {
  applyContractEvent,
  type DecodedMembershipMintedEvent,
} from '../src/services/contractEventHelpers';

/**
 * Cross-community scoping safeguards.
 */

describe('Cross-community leakage safeguards', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;

  beforeAll(async () => {
    prisma = new PrismaClient();
    app = Fastify({ logger: false });
    await registerRoutes(app);
  });

  beforeEach(async () => {
    await prisma.roleAssignment.deleteMany({});
    await prisma.membership.deleteMany({});
    await prisma.member.deleteMany({});
    await prisma.accessPolicy.deleteMany({});
    await prisma.wallet.deleteMany({});
    await prisma.profile.deleteMany({});
    await prisma.community.deleteMany({});
    await prisma.auditEvent.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test('community-scoped memberships endpoint must not return memberships from other communities', async () => {
    const wallet = '0xalice123456789abcdef1234567890abcdef';

    const eventA: DecodedMembershipMintedEvent = {
      type: 'MembershipMinted',
      to: wallet,
      tokenId: 101,
      communityId: 'community-A',
      expiresAt: Math.floor(Date.now() / 1000) + 60 * 60,
    };

    const eventB: DecodedMembershipMintedEvent = {
      type: 'MembershipMinted',
      to: wallet,
      tokenId: 202,
      communityId: 'community-B',
      expiresAt: Math.floor(Date.now() / 1000) + 60 * 60,
    };

    await applyContractEvent(prisma, eventA);
    await applyContractEvent(prisma, eventB);

    const resA = await app.inject({
      method: 'GET',
      url: `/v1/communities/community-A/memberships/${wallet}`,
    });

    expect(resA.statusCode).toBe(200);
    const bodyA = JSON.parse(resA.body);
    expect(bodyA.communities).toHaveLength(1);
    expect(bodyA.communities[0].communityId).toBe('community-A');

    const resB = await app.inject({
      method: 'GET',
      url: `/v1/communities/community-B/memberships/${wallet}`,
    });

    expect(resB.statusCode).toBe(200);
    const bodyB = JSON.parse(resB.body);
    expect(bodyB.communities).toHaveLength(1);
    expect(bodyB.communities[0].communityId).toBe('community-B');
  });
});


