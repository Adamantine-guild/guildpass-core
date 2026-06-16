import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Communities
  await prisma.community.upsert({
    where: { id: "guild1" },
    update: {},
    create: { id: "guild1", name: "Guild One" },
  });
  await prisma.community.upsert({
    where: { id: "guild2" },
    update: {},
    create: { id: "guild2", name: "Guild Two" },
  });

  // Wallets
  const alice = await prisma.wallet.upsert({
    where: { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    update: {},
    create: { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  });
  const bob = await prisma.wallet.upsert({
    where: { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    update: {},
    create: { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  });

  // Profiles
  const profileAlice = await prisma.profile.create({
    data: { displayName: "Alice" },
  });
  const profileBob = await prisma.profile.create({
    data: { displayName: "Bob" },
  });

  // Members in guild1
  const mAlice = await prisma.member.upsert({
    where: {
      communityId_walletId: { communityId: "guild1", walletId: alice.id },
    },
    update: {},
    create: {
      communityId: "guild1",
      walletId: alice.id,
      profileId: profileAlice.id,
    },
  });
  const mBob = await prisma.member.upsert({
    where: {
      communityId_walletId: { communityId: "guild1", walletId: bob.id },
    },
    update: {},
    create: {
      communityId: "guild1",
      walletId: bob.id,
      profileId: profileBob.id,
    },
  });
  // Memberships
  await prisma.membership.create({
    data: {
      memberId: mAlice.id,
      state: "active",
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    },
  });
  await prisma.membership.create({
    data: {
      memberId: mBob.id,
      state: "expired",
      expiresAt: new Date(Date.now() - 24 * 3600 * 1000),
    },
  });
  // Roles
  await prisma.roleAssignment.create({
    data: {
      memberId: mAlice.id,
      role: "admin",
      source: "manual",
      active: true,
    },
  });
  await prisma.roleAssignment.create({
    data: {
      memberId: mBob.id,
      role: "contributor",
      source: "manual",
      active: true,
    },
  });

  // Policies
  await prisma.accessPolicy.upsert({
    where: {
      communityId_resource: { communityId: "guild1", resource: "admin" },
    },
    update: { ruleType: "ADMINS_ONLY", params: {} },
    create: {
      communityId: "guild1",
      resource: "admin",
      ruleType: "ADMINS_ONLY",
      params: {},
    },
  });
  await prisma.accessPolicy.upsert({
    where: {
      communityId_resource: { communityId: "guild1", resource: "home" },
    },
    update: { ruleType: "PUBLIC", params: {} },
    create: {
      communityId: "guild1",
      resource: "home",
      ruleType: "PUBLIC",
      params: {},
    },
  });
  await prisma.accessPolicy.upsert({
    where: {
      communityId_resource: { communityId: "guild1", resource: "members-area" },
    },
    update: { ruleType: "MEMBERS_ONLY", params: {} },
    create: {
      communityId: "guild1",
      resource: "members-area",
      ruleType: "MEMBERS_ONLY",
      params: {},
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
