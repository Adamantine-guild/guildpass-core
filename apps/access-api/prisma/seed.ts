import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Idempotent: return the existing profile with the given display name, or
 * create one. Re-running the seed must never produce duplicate profiles.
 */
export async function findOrCreateProfile(
  prisma: PrismaClient,
  displayName: string
) {
  const existing = await prisma.profile.findFirst({ where: { displayName } });
  if (existing) return existing;
  return prisma.profile.create({ data: { displayName } });
}

/**
 * Idempotent: upsert membership by memberId. `memberId` has a `@unique`
 * constraint, so the second call updates the existing row to the seeded
 * state/expiresAt instead of erroring on duplicate.
 */
export async function upsertMembership(
  prisma: PrismaClient,
  memberId: string,
  data: { state: 'active' | 'expired' | 'invited' | 'suspended'; expiresAt: Date | null }
) {
  return prisma.membership.upsert({
    where: { memberId },
    create: { memberId, state: data.state, expiresAt: data.expiresAt },
    update: { state: data.state, expiresAt: data.expiresAt },
  });
}

/**
 * Idempotent: replace the active role assignments for a member with the
 * provided list. Re-running the seed must converge to the same role set
 * regardless of how many active rows exist from prior runs.
 */
export async function replaceActiveRoles(
  prisma: PrismaClient,
  memberId: string,
  roles: Array<{ role: 'admin' | 'member' | 'contributor'; source: 'manual' | 'auto' }>
) {
  await prisma.roleAssignment.deleteMany({ where: { memberId, active: true } });
  for (const r of roles) {
    await prisma.roleAssignment.create({
      data: { memberId, role: r.role, source: r.source, active: true },
    });
  }
}

export async function seedDatabase(prisma: PrismaClient) {
  // Communities (already idempotent via upsert)
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

  // Wallets (already idempotent via upsert)
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

  // Profiles (now idempotent via findOrCreate)
  const profileAlice = await findOrCreateProfile(prisma, 'Alice');
  const profileBob = await findOrCreateProfile(prisma, 'Bob');

  // Members (already idempotent via upsert)
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

  // Role assignments (now idempotent via delete-then-create)
  await replaceActiveRoles(prisma, mAlice.id, [{ role: 'admin', source: 'manual' }]);
  await replaceActiveRoles(prisma, mBob.id, [{ role: 'contributor', source: 'manual' }]);

  // Access policies (already idempotent via upsert)
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

async function main() {
  await seedDatabase(prisma);
}

// Only auto-run when this file is invoked directly (`ts-node prisma/seed.ts`,
// `node dist/prisma/seed.js`, `pnpm seed`). When imported by tests, the
// side-effecting `main()` and the real `PrismaClient` connection must stay
// dormant so the unit tests can drive `seedDatabase` against a mock prisma.
if (require.main === module) {
  main()
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (e) => {
      console.error(e);
      await prisma.$disconnect();
      process.exit(1);
    });
}
