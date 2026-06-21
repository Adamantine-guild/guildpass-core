import {
  findOrCreateProfile,
  upsertMembership,
  replaceActiveRoles,
  seedDatabase,
} from '../prisma/seed';

/**
 * Build a minimal in-memory mock of the PrismaClient surface used by
 * seedDatabase. Each model records its call args and stores rows in a Map
 * keyed by the relevant unique field so we can assert on real idempotency
 * (second call observes the rows created by the first).
 */
function createMockPrisma() {
  const profileByName = new Map();
  const membershipByMemberId = new Map();
  const rolesByMember = new Map();
  const communityById = new Map();
  const walletByAddress = new Map();
  const memberByKey = new Map();
  const policyByKey = new Map();

  const community = {
    upsert: jest.fn(async ({ where: { id }, create }) => {
      if (communityById.has(id)) return communityById.get(id);
      const row = { id, name: create.name };
      communityById.set(id, row);
      return row;
    }),
  };

  const wallet = {
    upsert: jest.fn(async ({ where: { address }, create }) => {
      if (walletByAddress.has(address)) return walletByAddress.get(address);
      const row = { id: `wallet-${walletByAddress.size + 1}`, address };
      walletByAddress.set(address, row);
      return row;
    }),
  };

  const profile = {
    findFirst: jest.fn(async ({ where: { displayName } }) => {
      return profileByName.get(displayName) ?? null;
    }),
    create: jest.fn(async ({ data: { displayName } }) => {
      const row = { id: `profile-${profileByName.size + 1}`, displayName };
      profileByName.set(displayName, row);
      return row;
    }),
  };

  const member = {
    upsert: jest.fn(async ({ where: { communityId_walletId }, create }) => {
      const key = `${communityId_walletId.communityId}:${communityId_walletId.walletId}`;
      if (memberByKey.has(key)) return memberByKey.get(key);
      const row = {
        id: `member-${memberByKey.size + 1}`,
        communityId: communityId_walletId.communityId,
        walletId: communityId_walletId.walletId,
        profileId: create.profileId,
      };
      memberByKey.set(key, row);
      return row;
    }),
  };

  const membership = {
    upsert: jest.fn(async ({ where: { memberId }, create, update }) => {
      if (membershipByMemberId.has(memberId)) {
        const existing = membershipByMemberId.get(memberId);
        const updated = { ...existing, state: update.state, expiresAt: update.expiresAt };
        membershipByMemberId.set(memberId, updated);
        return updated;
      }
      const row = {
        id: `membership-${membershipByMemberId.size + 1}`,
        memberId,
        state: create.state,
        expiresAt: create.expiresAt,
      };
      membershipByMemberId.set(memberId, row);
      return row;
    }),
  };

  const roleAssignment = {
    deleteMany: jest.fn(async ({ where: { memberId } }) => {
      rolesByMember.set(memberId, []);
      return { count: 0 };
    }),
    create: jest.fn(async ({ data }) => {
      const list = rolesByMember.get(data.memberId) ?? [];
      const row = { id: `role-${list.length + 1}`, ...data };
      list.push(row);
      rolesByMember.set(data.memberId, list);
      return row;
    }),
  };

  const accessPolicy = {
    upsert: jest.fn(async ({ where: { communityId_resource }, create }) => {
      const key = `${communityId_resource.communityId}:${communityId_resource.resource}`;
      if (policyByKey.has(key)) return policyByKey.get(key);
      const row = { id: `policy-${policyByKey.size + 1}`, ...create };
      policyByKey.set(key, row);
      return row;
    }),
  };

  return {
    community,
    wallet,
    profile,
    member,
    membership,
    roleAssignment,
    accessPolicy,
    _state: {
      profileByName,
      membershipByMemberId,
      rolesByMember,
      communityById,
      walletByAddress,
      memberByKey,
      policyByKey,
    },
  } as any;
}

describe('seedDatabase — idempotency', () => {
  it('runs twice without producing duplicate profiles, memberships, or roles', async () => {
    const prisma = createMockPrisma();

    await seedDatabase(prisma);
    const first = {
      profileCreates: prisma.profile.create.mock.calls.length,
      membershipUpserts: prisma.membership.upsert.mock.calls.length,
      roleCreates: prisma.roleAssignment.create.mock.calls.length,
      profileByName: Array.from(prisma._state.profileByName.values()),
      rolesByMember: Array.from(prisma._state.rolesByMember.entries()).map(
        (entry: any) => [entry[0], entry[1].length] as [string, number]
      ),
    };

    await seedDatabase(prisma);
    const second = {
      profileCreates: prisma.profile.create.mock.calls.length,
      membershipUpserts: prisma.membership.upsert.mock.calls.length,
      roleCreates: prisma.roleAssignment.create.mock.calls.length,
      profileByName: Array.from(prisma._state.profileByName.values()),
      rolesByMember: Array.from(prisma._state.rolesByMember.entries()).map(
        (entry: any) => [entry[0], entry[1].length] as [string, number]
      ),
    };

    expect(second.profileCreates).toBe(first.profileCreates);
    expect(second.profileByName).toHaveLength(first.profileByName.length);
    expect(second.rolesByMember).toEqual(first.rolesByMember);

    expect(second.membershipUpserts).toBe(first.membershipUpserts * 2);
    expect(prisma._state.membershipByMemberId.size).toBe(2);
  });
});

describe('findOrCreateProfile', () => {
  it('creates on first call, returns existing on second', async () => {
    const prisma = createMockPrisma();
    const a = await findOrCreateProfile(prisma, 'Alice');
    const b = await findOrCreateProfile(prisma, 'Alice');
    expect(a.id).toBe(b.id);
    expect(prisma.profile.create).toHaveBeenCalledTimes(1);
    expect(prisma.profile.findFirst).toHaveBeenCalledTimes(2);
  });
});

describe('upsertMembership', () => {
  it('updates state/expiresAt on second call, never inserts twice', async () => {
    const prisma = createMockPrisma();
    const initial = new Date('2026-01-01T00:00:00Z');
    const later = new Date('2026-02-01T00:00:00Z');
    await upsertMembership(prisma, 'm1', { state: 'active', expiresAt: initial });
    await upsertMembership(prisma, 'm1', { state: 'expired', expiresAt: later });
    const row = prisma._state.membershipByMemberId.get('m1');
    expect(row.state).toBe('expired');
    expect(row.expiresAt).toBe(later);
    expect(prisma._state.membershipByMemberId.size).toBe(1);
  });
});

describe('replaceActiveRoles', () => {
  it('converges to the seeded role set on repeated runs', async () => {
    const prisma = createMockPrisma();
    await replaceActiveRoles(prisma, 'm1', [{ role: 'admin', source: 'manual' }]);
    await replaceActiveRoles(prisma, 'm1', [{ role: 'admin', source: 'manual' }]);
    expect(prisma._state.rolesByMember.get('m1')).toHaveLength(1);
    expect(prisma.roleAssignment.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.roleAssignment.create).toHaveBeenCalledTimes(2);
  });
});
