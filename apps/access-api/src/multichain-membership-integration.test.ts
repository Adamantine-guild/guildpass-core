/**
 * Multi-Chain Membership Integration Test
 *
 * Validates multi-chain membership capabilities across multiple chains:
 * 1. Event processing & token scoping per (chainId, contractAddress)
 * 2. Cross-chain event collision safety (same tokenId on Chain A & Chain B)
 * 3. Cross-chain conflict resolution policy enforcement:
 *    - Active on Chain A + Suspended on Chain B -> Suspended (Deny Access)
 *    - Expired on Chain A + Active on Chain B -> Active (Grant Access)
 */

import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { registerRoutes } from './routes';
import {
  applyContractEvent,
  type DecodedMembershipMintedEvent,
  type DecodedMembershipSuspendedEvent,
} from './services/contractEventHelpers';

describe('Multi-Chain Membership Integration', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  const CHAIN_MAINNET = 1;
  const CHAIN_POLYGON = 137;
  const ADDR_MAINNET = '0x1111111111111111111111111111111111111111';
  const ADDR_POLYGON = '0x2222222222222222222222222222222222222222';
  const COMMUNITY_ID = 'community-multichain-test';
  const TEST_WALLET = '0x9999999999999999999999999999999999999999';

  beforeAll(async () => {
    prisma = new PrismaClient();
    app = Fastify({ logger: false });
    registerRoutes(app);

    await prisma.processedEvent.deleteMany({});
    await prisma.roleAssignment.deleteMany({});
    await prisma.membership.deleteMany({});
    await prisma.membershipToken.deleteMany({});
    await prisma.communityContract.deleteMany({});
    await prisma.member.deleteMany({});
    await prisma.accessPolicy.deleteMany({});
    await prisma.community.deleteMany({});
    await prisma.wallet.deleteMany({});
  });

  beforeEach(async () => {
    await prisma.processedEvent.deleteMany({});
    await prisma.roleAssignment.deleteMany({});
    await prisma.membership.deleteMany({});
    await prisma.membershipToken.deleteMany({});
    await prisma.communityContract.deleteMany({});
    await prisma.member.deleteMany({});
    await prisma.accessPolicy.deleteMany({});
    await prisma.wallet.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test('should process events across multiple chains without token or event collision', async () => {
    // Mint token #100 on Ethereum Mainnet
    const eventMainnet: DecodedMembershipMintedEvent = {
      type: 'MembershipMinted',
      to: TEST_WALLET,
      tokenId: 100,
      communityId: COMMUNITY_ID,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      chainId: CHAIN_MAINNET,
      contractAddress: ADDR_MAINNET,
      txHash: '0xhash_mainnet_100',
      blockNumber: 1000,
      logIndex: 0,
    };

    // Mint same token #100 on Polygon
    const eventPolygon: DecodedMembershipMintedEvent = {
      type: 'MembershipMinted',
      to: TEST_WALLET,
      tokenId: 100,
      communityId: COMMUNITY_ID,
      expiresAt: Math.floor(Date.now() / 1000) + 7200,
      chainId: CHAIN_POLYGON,
      contractAddress: ADDR_POLYGON,
      txHash: '0xhash_polygon_100',
      blockNumber: 5000,
      logIndex: 0,
    };

    await applyContractEvent(prisma, eventMainnet);
    await applyContractEvent(prisma, eventPolygon);

    // Both tokens should exist in database disambiguated by chainId and contractAddress
    const tokenMainnet = await prisma.membershipToken.findUnique({
      where: {
        chainId_contractAddress_tokenId: {
          chainId: CHAIN_MAINNET,
          contractAddress: ADDR_MAINNET,
          tokenId: 100,
        },
      },
    });

    const tokenPolygon = await prisma.membershipToken.findUnique({
      where: {
        chainId_contractAddress_tokenId: {
          chainId: CHAIN_POLYGON,
          contractAddress: ADDR_POLYGON,
          tokenId: 100,
        },
      },
    });

    expect(tokenMainnet).toBeDefined();
    expect(tokenPolygon).toBeDefined();
    expect(tokenMainnet?.chainId).toBe(CHAIN_MAINNET);
    expect(tokenPolygon?.chainId).toBe(CHAIN_POLYGON);

    // Verify community contracts registered
    const contracts = await prisma.communityContract.findMany({
      where: { communityId: COMMUNITY_ID },
    });
    expect(contracts).toHaveLength(2);
  });

  test('should enforce Suspension-First resolution when active on Chain A but suspended on Chain B', async () => {
    // Active mint on Mainnet
    const mintMainnet: DecodedMembershipMintedEvent = {
      type: 'MembershipMinted',
      to: TEST_WALLET,
      tokenId: 1,
      communityId: COMMUNITY_ID,
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      chainId: CHAIN_MAINNET,
      contractAddress: ADDR_MAINNET,
      txHash: '0xhash_m1',
      blockNumber: 100,
      logIndex: 0,
    };

    // Active mint on Polygon
    const mintPolygon: DecodedMembershipMintedEvent = {
      type: 'MembershipMinted',
      to: TEST_WALLET,
      tokenId: 2,
      communityId: COMMUNITY_ID,
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      chainId: CHAIN_POLYGON,
      contractAddress: ADDR_POLYGON,
      txHash: '0xhash_p1',
      blockNumber: 200,
      logIndex: 0,
    };

    // Suspension event on Polygon
    const suspendPolygon: DecodedMembershipSuspendedEvent = {
      type: 'MembershipSuspended',
      tokenId: 2,
      isSuspended: true,
      chainId: CHAIN_POLYGON,
      contractAddress: ADDR_POLYGON,
      txHash: '0xhash_p2',
      blockNumber: 201,
      logIndex: 0,
    };

    await applyContractEvent(prisma, mintMainnet);
    await applyContractEvent(prisma, mintPolygon);
    await applyContractEvent(prisma, suspendPolygon);

    await prisma.accessPolicy.create({
      data: {
        communityId: COMMUNITY_ID,
        resource: 'secret-vault',
        ruleType: 'MEMBERS_ONLY',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/access/check',
      payload: {
        wallet: TEST_WALLET,
        communityId: COMMUNITY_ID,
        resource: 'secret-vault',
      },
    });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body);
    // Conflict resolution policy: Suspension on ANY configured chain overrides active status
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('DENY');
    expect(result.membershipState).toBe('suspended');
  });

  test('should allow access when expired on Chain A but active on Chain B', async () => {
    // Expired mint on Mainnet
    const expiredMainnet: DecodedMembershipMintedEvent = {
      type: 'MembershipMinted',
      to: TEST_WALLET,
      tokenId: 10,
      communityId: COMMUNITY_ID,
      expiresAt: Math.floor(Date.now() / 1000) - 3600, // expired
      chainId: CHAIN_MAINNET,
      contractAddress: ADDR_MAINNET,
      txHash: '0xhash_exp1',
      blockNumber: 10,
      logIndex: 0,
    };

    // Active mint on Polygon
    const activePolygon: DecodedMembershipMintedEvent = {
      type: 'MembershipMinted',
      to: TEST_WALLET,
      tokenId: 20,
      communityId: COMMUNITY_ID,
      expiresAt: Math.floor(Date.now() / 1000) + 86400, // active
      chainId: CHAIN_POLYGON,
      contractAddress: ADDR_POLYGON,
      txHash: '0xhash_act1',
      blockNumber: 20,
      logIndex: 0,
    };

    await applyContractEvent(prisma, expiredMainnet);
    await applyContractEvent(prisma, activePolygon);

    await prisma.accessPolicy.create({
      data: {
        communityId: COMMUNITY_ID,
        resource: 'dashboard',
        ruleType: 'MEMBERS_ONLY',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/access/check',
      payload: {
        wallet: TEST_WALLET,
        communityId: COMMUNITY_ID,
        resource: 'dashboard',
      },
    });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body);
    expect(result.allowed).toBe(true);
    expect(result.code).toBe('ALLOW');
    expect(result.membershipState).toBe('active');
  });
});
