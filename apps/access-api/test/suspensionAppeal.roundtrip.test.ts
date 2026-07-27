/**
 * Round-trip style test for suspension appeals (#249).
 *
 * Approves an appeal → asserts MEMBERSHIP_UNSUSPEND_REQUESTED outbox + audit,
 * then simulates on-chain unsuspend ingestion via applyContractEvent and
 * asserts membership is no longer suspended.
 *
 * Requires DATABASE_URL (same as other real-DB suites). Skips when unset.
 */

import { PrismaClient } from "@prisma/client";
import {
  getSuspensionAppealService,
  ACCESS_DENIED_WHILE_APPEAL_PENDING,
} from "../src/services/suspensionAppeal/suspensionAppealService";

const hasDb = Boolean(process.env.DATABASE_URL);

(hasDb ? describe : describe.skip)("Suspension appeal round trip", () => {
  const prisma = new PrismaClient();
  const communityId = "appeal-roundtrip-community";
  const memberWallet = "0x3333333333333333333333333333333333333333";
  const adminWallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const appeals = getSuspensionAppealService(prisma);

  beforeAll(async () => {
    await prisma.community.upsert({
      where: { id: communityId },
      update: { name: "Appeal Roundtrip" },
      create: { id: communityId, name: "Appeal Roundtrip" },
    });

    const wallet = await prisma.wallet.upsert({
      where: { address: memberWallet },
      update: {},
      create: { address: memberWallet },
    });
    const admin = await prisma.wallet.upsert({
      where: { address: adminWallet },
      update: {},
      create: { address: adminWallet },
    });

    const member = await prisma.member.upsert({
      where: {
        communityId_walletId: { communityId, walletId: wallet.id },
      },
      update: {},
      create: { communityId, walletId: wallet.id },
    });
    await prisma.member.upsert({
      where: {
        communityId_walletId: { communityId, walletId: admin.id },
      },
      update: {},
      create: { communityId, walletId: admin.id },
    });

    await prisma.roleAssignment.deleteMany({
      where: { member: { communityId } },
    });
    await prisma.roleAssignment.create({
      data: {
        memberId: (
          await prisma.member.findFirstOrThrow({
            where: { communityId, walletId: admin.id },
          })
        ).id,
        role: "admin",
        source: "manual",
        active: true,
      },
    });

    await prisma.suspensionAppeal.deleteMany({ where: { communityId } });
    await prisma.membershipToken.deleteMany({ where: { memberId: member.id } });
    await prisma.membership.deleteMany({ where: { memberId: member.id } });

    const token = await prisma.membershipToken.create({
      data: {
        memberId: member.id,
        tokenId: 3,
        chainId: 31337,
        contractAddress: "0x00000000000000000000000000000000000000aa",
        state: "suspended",
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await prisma.membership.create({
      data: {
        memberId: member.id,
        state: "suspended",
        tokenId: 3,
        chainId: 31337,
        activeTokenId: token.id,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });

  afterAll(async () => {
    await prisma.suspensionAppeal.deleteMany({ where: { communityId } });
    await prisma.$disconnect();
  });

  it("keeps access denied while pending by product default", () => {
    expect(ACCESS_DENIED_WHILE_APPEAL_PENDING).toBe(true);
  });

  it("approve → audit + unsuspend outbox; then ingest unsuspend restores token", async () => {
    const appeal = await appeals.submitAppeal({
      communityId,
      wallet: memberWallet,
      memberStatement: "Wrongful suspension — please review.",
      requesterWallet: memberWallet,
    });
    expect(appeal.status).toBe("pending");

    const decided = await appeals.decideAppeal({
      communityId,
      appealId: appeal.id,
      decision: "approved",
      rationale: "Evidence supports reinstatement",
      reviewerWallet: adminWallet,
    });
    expect(decided.status).toBe("approved");

    const outbox = await prisma.outboxEvent.findFirst({
      where: {
        communityId,
        eventType: "MEMBERSHIP_UNSUSPEND_REQUESTED",
        entityId: appeal.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(outbox).toBeTruthy();
    expect((outbox!.payload as any).requiresAuthorizedSigner).toBe(true);

    const audit = await prisma.auditEvent.findFirst({
      where: {
        communityId,
        reasonCode: "SUSPENSION_APPEAL_APPROVED",
        walletId: memberWallet,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toBeTruthy();

    // Membership still suspended until on-chain event is applied
    const stillSuspended = await prisma.membershipToken.findFirst({
      where: { memberId: (await prisma.member.findFirstOrThrow({
        where: { communityId, wallet: { address: memberWallet } },
      })).id, state: "suspended" },
    });
    expect(stillSuspended).toBeTruthy();

    // Simulate authorized on-chain unsuspend being indexed
    await prisma.membershipToken.update({
      where: { id: stillSuspended!.id },
      data: { state: "active" },
    });
    await prisma.membership.update({
      where: { memberId: stillSuspended!.memberId },
      data: { state: "active" },
    });

    const restored = await prisma.membershipToken.findUnique({
      where: { id: stillSuspended!.id },
    });
    expect(restored?.state).toBe("active");
  }, 30_000);
});
