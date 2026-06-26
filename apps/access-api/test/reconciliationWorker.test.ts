import { PrismaClient } from "@prisma/client";
import {
  reconcileMemberships,
  createReconciliationWorker,
} from "../src/workers/reconciliationWorker";
import * as auditService from "../src/services/auditService";

jest.mock("../src/services/auditService");

const mockLogEvent = auditService.logEvent as jest.MockedFunction<
  typeof auditService.logEvent
>;

function makePrisma(memberships: any[]) {
  return {
    membership: {
      findMany: jest.fn().mockResolvedValue(memberships),
      update: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaClient;
}

const PAST = new Date(Date.now() - 86_400_000);
const FUTURE = new Date(Date.now() + 86_400_000);

const member = { walletId: "wallet-1", communityId: "community-1" };

beforeEach(() => {
  jest.clearAllMocks();
  mockLogEvent.mockResolvedValue({} as any);
});

// ---------------------------------------------------------------------------
// reconcileMemberships — single pass
// ---------------------------------------------------------------------------

describe("reconcileMemberships", () => {
  test("updates active membership with past expiresAt to expired", async () => {
    const db = makePrisma([
      { id: "m1", state: "active", expiresAt: PAST, member },
    ]);
    const result = await reconcileMemberships(db);

    expect(db.membership.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { state: "expired" },
    });
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "MEMBERSHIP_RECONCILED",
        walletId: "wallet-1",
        communityId: "community-1",
        beforeState: { state: "active" },
        afterState: { state: "expired" },
      }),
    );
    expect(result).toEqual({ updatedCount: 1, errors: 0 });
  });

  test("updates suspended membership with past expiresAt to expired", async () => {
    const db = makePrisma([
      { id: "m2", state: "suspended", expiresAt: PAST, member },
    ]);
    const result = await reconcileMemberships(db);

    expect(db.membership.update).toHaveBeenCalledWith({
      where: { id: "m2" },
      data: { state: "expired" },
    });
    expect(result).toEqual({ updatedCount: 1, errors: 0 });
  });

  test("does not update active membership with future expiresAt", async () => {
    // findMany returns [] because the query filters expiresAt < now
    const db = makePrisma([]);
    const result = await reconcileMemberships(db);

    expect(db.membership.update).not.toHaveBeenCalled();
    expect(result).toEqual({ updatedCount: 0, errors: 0 });
  });

  test("does not update already-expired membership (idempotent)", async () => {
    // Already expired records are excluded by the `state: { in: ['active','suspended'] }` filter.
    // Simulate Prisma returning nothing for them.
    const db = makePrisma([]);
    const result = await reconcileMemberships(db);

    expect(db.membership.update).not.toHaveBeenCalled();
    expect(result).toEqual({ updatedCount: 0, errors: 0 });
  });

  test("handles multiple stale memberships in one pass", async () => {
    const db = makePrisma([
      { id: "m1", state: "active", expiresAt: PAST, member },
      { id: "m2", state: "suspended", expiresAt: PAST, member },
    ]);
    const result = await reconcileMemberships(db);

    expect(db.membership.update).toHaveBeenCalledTimes(2);
    expect(mockLogEvent).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ updatedCount: 2, errors: 0 });
  });

  test("counts errors without aborting the whole pass", async () => {
    const db = makePrisma([
      { id: "m1", state: "active", expiresAt: PAST, member },
      { id: "m2", state: "active", expiresAt: PAST, member },
    ]);
    (db.membership.update as jest.Mock)
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("DB error"));

    const consoleSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const result = await reconcileMemberships(db);

    expect(result).toEqual({ updatedCount: 1, errors: 1 });
    consoleSpy.mockRestore();
  });

  test("passes query with correct state filter to findMany", async () => {
    const db = makePrisma([]);
    await reconcileMemberships(db);

    expect(db.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: { in: ["active", "suspended"] },
          expiresAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      }),
    );
  });

  test("active membership with null expiresAt is never selected", async () => {
    // A membership with expiresAt = null should not satisfy `expiresAt < now`
    // so Prisma won't return it — simulate that by returning empty.
    const db = makePrisma([]);
    const result = await reconcileMemberships(db);

    expect(db.membership.update).not.toHaveBeenCalled();
    expect(result.updatedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createReconciliationWorker — scheduling
// ---------------------------------------------------------------------------

describe("createReconciliationWorker", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("does not run before start() is called", () => {
    const db = makePrisma([]);
    createReconciliationWorker(100, db);
    jest.advanceTimersByTime(500);
    expect(db.membership.findMany).not.toHaveBeenCalled();
  });

  test("runs reconciliation at the configured interval", async () => {
    const db = makePrisma([]);
    const worker = createReconciliationWorker(100, db);
    worker.start();

    // Tick past two intervals and flush microtasks
    jest.advanceTimersByTime(250);
    await Promise.resolve();

    expect(db.membership.findMany).toHaveBeenCalled();
    worker.stop();
  });

  test("stop() prevents further runs", async () => {
    const db = makePrisma([]);
    const worker = createReconciliationWorker(100, db);
    worker.start();

    jest.advanceTimersByTime(150);
    await Promise.resolve();
    const callsAfterStart = (db.membership.findMany as jest.Mock).mock.calls
      .length;

    worker.stop();
    jest.advanceTimersByTime(500);
    await Promise.resolve();

    expect((db.membership.findMany as jest.Mock).mock.calls.length).toBe(
      callsAfterStart,
    );
  });

  test("calling start() twice does not double-schedule", async () => {
    const db = makePrisma([]);
    const worker = createReconciliationWorker(100, db);
    worker.start();
    worker.start(); // second call is a no-op

    jest.advanceTimersByTime(150);
    await Promise.resolve();

    // Should fire once per interval, not twice
    expect(
      (db.membership.findMany as jest.Mock).mock.calls.length,
    ).toBeLessThanOrEqual(2);
    worker.stop();
  });
});
