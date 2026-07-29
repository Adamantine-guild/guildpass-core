import { PrismaClient } from '@prisma/client';
import { getModerationService, ModerationError } from './moderationService';

describe('Moderation Service Tests', () => {
  let prisma: PrismaClient;
  let moderationService: ReturnType<typeof getModerationService>;
  const communityId = 'mod-service-test-community';
  const walletAddress = '0x1111111111111111111111111111111111111111';

  beforeAll(async () => {
    prisma = new PrismaClient();
    moderationService = getModerationService(prisma);

    await prisma.community.upsert({
      where: { id: communityId },
      update: {},
      create: { id: communityId, name: 'Moderation Test Community' },
    });
  });

  afterAll(async () => {
    await prisma.appeal.deleteMany({ where: { member: { communityId } } });
    await prisma.membershipToken.deleteMany({ where: { member: { communityId } } });
    await prisma.membership.deleteMany({ where: { member: { communityId } } });
    await prisma.member.deleteMany({ where: { communityId } });
    await prisma.wallet.deleteMany({ where: { address: walletAddress } });
    await prisma.community.deleteMany({ where: { id: communityId } });
    await prisma.$disconnect();
  });

  test('should reject invalid transition directly from filed to reinstated', async () => {
    const wallet = await prisma.wallet.create({
      data: { address: walletAddress },
    });

    const member = await prisma.member.create({
      data: {
        communityId,
        walletId: wallet.id,
      },
    });

    const membership = await prisma.membership.create({
      data: {
        memberId: member.id,
        state: 'suspended',
      },
    });

    const token = await prisma.membershipToken.create({
      data: {
        memberId: member.id,
        chainId: 1,
        contractAddress: '0xcontract',
        tokenId: 101,
        state: 'suspended',
      },
    });

    await prisma.membership.update({
      where: { id: membership.id },
      data: { activeTokenId: token.id },
    });

    const appeal = await moderationService.fileAppeal(walletAddress, communityId, 'Unfair suspension');
    expect(appeal.status).toBe('filed');

    // Attempt invalid direct transition from filed to reinstated
    await expect(
      moderationService.transitionAppeal(appeal.id, 'reinstated', 'Admin comment', '0xadmin'),
    ).rejects.toThrow(ModerationError);
  });

  test('should complete valid transition flow (filed -> under_review -> reinstated) and emit outbox event', async () => {
    const wallet = await prisma.wallet.findUnique({ where: { address: walletAddress } });
    const member = await prisma.member.findFirst({ where: { walletId: wallet!.id, communityId } });
    const appeal = await prisma.appeal.findFirst({ where: { memberId: member!.id } });

    // Transition to under_review
    const reviewed = await moderationService.transitionAppeal(appeal!.id, 'under_review', 'Reviewing');
    expect(reviewed.status).toBe('under_review');

    // Transition to reinstated
    const reinstated = await moderationService.transitionAppeal(appeal!.id, 'reinstated', 'Approved reinstatement', '0xadmin');
    expect(reinstated.status).toBe('reinstated');

    // Verify token state restored to active
    const updatedToken = await prisma.membershipToken.findFirst({ where: { memberId: member!.id } });
    expect(updatedToken?.state).toBe('active');

    // Verify outbox event emitted
    const outbox = await prisma.outboxEvent.findFirst({
      where: { communityId, eventType: 'MEMBERSHIP_REINSTATED' },
    });
    expect(outbox).not.toBeNull();
  });
});
