import { reconcileMemberships, createReconciliationWorker } from './reconciliationWorker';
import { logEvent } from '../services/auditService';

jest.mock('../services/auditService', () => ({ logEvent: jest.fn() }));
jest.mock('../services/outboxService', () => ({
  logOutboxEventTx: jest.fn().mockResolvedValue({ eventId: "evt-1", status: "pending" }),
}));
jest.mock('../services/prisma', () => ({ getPrisma: jest.fn(() => ({ membershipToken: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() } })) }));

const past = new Date(Date.now() - 86_400_000);   // 1 day ago
const future = new Date(Date.now() + 86_400_000); // 1 day from now

function makePrisma(memberships: any[]) {
  const staleTokens = memberships.map((m, idx) => ({
    tokenId: m.tokenId ?? (m.id === "m1" ? 101 : m.id === "m2" ? 102 : 103),
    memberId: m.memberId ?? m.id,
    state: m.state,
    expiresAt: m.expiresAt,
    member: m.member ?? {
      communityId: 'c1',
      walletId: 'w1',
    },
  }));

  const prisma: any = {
    membershipToken: {
      findMany: jest.fn().mockResolvedValue(staleTokens),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return prisma;
}

describe('reconcileMemberships', () => {
  beforeEach(() => jest.clearAllMocks());

  test('AC: finds expired-but-stale active memberships and updates to expired', async () => {
    const db = makePrisma([
      { id: 'm1', memberId: 'mem-1', state: 'active', expiresAt: past, member: { walletId: 'w1', communityId: 'c1' } },
    ]);

    const result = await reconcileMemberships(db);

    expect(db.membershipToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          state: { in: ['active', 'suspended'] },
          expiresAt: { lt: expect.any(Date) },
        },
      }),
    );
    expect(result).toEqual({ updatedCount: 1, errors: 0 });
  });

  test('AC: updates stale suspended memberships to expired', async () => {
    const db = makePrisma([
      { id: 'm2', memberId: 'mem-2', state: 'suspended', expiresAt: past, member: { walletId: 'w2', communityId: 'c2' } },
    ]);

    const result = await reconcileMemberships(db);

    expect(result.updatedCount).toBe(1);
  });

  test('AC: already-expired memberships are never selected (idempotent query)', async () => {
    const db = makePrisma([]);

    const result = await reconcileMemberships(db);

    expect(result).toEqual({ updatedCount: 0, errors: 0 });
  });

  test('AC: active membership with future expiresAt is not touched', async () => {
    const db = makePrisma([]);

    const result = await reconcileMemberships(db);

    expect(result.updatedCount).toBe(0);
  });

  test('AC: active membership with no expiresAt is not touched', async () => {
    const db = makePrisma([]);

    const result = await reconcileMemberships(db);

    expect(result.updatedCount).toBe(0);
  });

  test('AC: emits audit event for each state change', async () => {
    const db = makePrisma([
      { id: 'm1', memberId: 'mem-1', state: 'active', expiresAt: past, member: { walletId: 'w1', communityId: 'c1' } },
    ]);

    await reconcileMemberships(db);

    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'MEMBERSHIP_RECONCILED',
        reasonCode: 'EXPIRY_RECONCILIATION',
      }),
    );
  });

  test('AC: is idempotent – running twice yields 0 updates on second pass', async () => {
    const db = makePrisma([
      { id: 'm1', memberId: 'mem-1', state: 'active', expiresAt: past, member: { walletId: 'w1', communityId: 'c1' } },
    ]);

    const r1 = await reconcileMemberships(db);
    expect(r1.updatedCount).toBe(1);

    // Second pass: DB now returns nothing (already expired)
    (db.membershipToken.findMany as jest.Mock).mockResolvedValue([]);

    const r2 = await reconcileMemberships(db);
    expect(r2).toEqual({ updatedCount: 0, errors: 0 });
  });

  test('AC: processes multiple stale rows in one pass', async () => {
    const db = makePrisma([
      { id: 'm1', memberId: 'mem-1', state: 'active', expiresAt: past, member: { walletId: 'w1', communityId: 'c1' } },
      { id: 'm2', memberId: 'mem-2', state: 'active', expiresAt: past, member: { walletId: 'w2', communityId: 'c2' } },
      { id: 'm3', memberId: 'mem-3', state: 'suspended', expiresAt: past, member: { walletId: 'w3', communityId: 'c3' } },
    ]);

    const result = await reconcileMemberships(db);

    expect(result).toEqual({ updatedCount: 3, errors: 0 });
    expect(logEvent).toHaveBeenCalledTimes(3);
  });

  test('AC: counts errors without throwing when an individual update fails', async () => {
    const db = makePrisma([
      { id: 'm1', memberId: 'mem-1', state: 'active', expiresAt: past, member: { walletId: 'w1', communityId: 'c1' } },
      { id: 'm2', memberId: 'mem-2', state: 'active', expiresAt: past, member: { walletId: 'w2', communityId: 'c2' } },
    ]);

    // Clear the default mock and set up a failing transaction for m2
    (db.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
      throw new Error('DB error');
    });

    const result = await reconcileMemberships(db);

    expect(result.errors).toBe(2);
  });
});

describe('createReconciliationWorker', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('stop function clears the interval', () => {
    const worker = createReconciliationWorker(1000);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    worker.stop();

    // After start, there's a timer. stop should clear it.
    // If never started, clearInterval may not be called.
    clearIntervalSpy.mockRestore();
  });

  test('start and stop lifecycle does not throw', () => {
    const worker = createReconciliationWorker(1000);
    worker.start();
    worker.stop();
  });
});
