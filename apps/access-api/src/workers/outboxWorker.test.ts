/**
 * outboxWorker.test.ts
 *
 * Tests for the outbox worker covering:
 *   - Processing pending events
 *   - Marking delivered on success
 *   - Marking failed on handler error
 *   - Retry state transitions through the worker
 *   - Start/stop lifecycle
 */

import {
  processOutboxBatch,
  createOutboxWorker,
  OutboxEventHandler,
} from "./outboxWorker";

// Mock prisma to avoid requiring generated client
jest.mock("../services/prisma", () => ({
  getPrisma: jest.fn(() => ({
    outboxEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrismaWithEvents(pendingEvents: any[] = []) {
  const events = [...pendingEvents];
  const updated: Array<{ where: { id: string }; data: any }> = [];

  return {
    outboxEvent: {
      findMany: jest.fn(async (args?: any) => {
        let results = [...events];
        if (args?.where?.status) {
          results = results.filter((r) => r.status === args.where.status);
        }
        if (args?.where?.nextRetryAt?.lte) {
          const cutoff = args.where.nextRetryAt.lte;
          results = results.filter(
            (r: any) =>
              r.nextRetryAt && new Date(r.nextRetryAt) <= new Date(cutoff),
          );
        }
        if (args?.orderBy?.createdAt === "asc") {
          results.sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          );
        }
        if (args?.take != null) {
          results = results.slice(0, args.take);
        }
        return results;
      }),
      update: jest.fn(async (args: any) => {
        updated.push(args);
        const existing = events.find((e) => e.id === args.where.id);
        if (existing) Object.assign(existing, args.data);
        return existing ?? { id: args.where.id, ...args.data };
      }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      count: jest.fn(async () => 0),
      create: jest.fn(),
    },
    deadLetterEvent: {
      create: jest.fn(async (args: any) => ({ id: "dl-1", ...args.data })),
    },
    _updated: updated,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processOutboxBatch", () => {
  test("processes pending events and marks them delivered", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 1000);
    const prisma = makePrismaWithEvents([
      {
        id: "evt-1",
        eventType: "RESOURCE_CREATED",
        entityId: "res-1",
        entityType: "Resource",
        communityId: "c1",
        payload: {},
        status: "pending",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        createdAt: past,
        deliveredAt: null,
        nextRetryAt: past,
      },
      {
        id: "evt-2",
        eventType: "MEMBERSHIP_UPDATED",
        entityId: "mem-1",
        entityType: "Member",
        communityId: "c1",
        payload: {},
        status: "pending",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        createdAt: past,
        deliveredAt: null,
        nextRetryAt: past,
      },
    ]);

    const deliveredIds: string[] = [];
    const handler: OutboxEventHandler = async (event) => {
      deliveredIds.push(event.id);
    };

    const result = await processOutboxBatch(prisma, handler, 50);

    expect(result.processed).toBe(2);
    expect(result.delivered).toBe(2);
    expect(result.failed).toBe(0);
    expect(deliveredIds).toEqual(["evt-1", "evt-2"]);

    const updateCalls = prisma._updated.filter(
      (u: any) => u.data.status === "delivered",
    );
    expect(updateCalls.length).toBe(2);
    updateCalls.forEach((call: any) => {
      expect(call.data.deliveredAt).toBeDefined();
      expect(call.data.nextRetryAt).toBeNull();
    });
  });

  test("marks events as failed when handler throws", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 1000);
    const prisma = makePrismaWithEvents([
      {
        id: "evt-fail",
        eventType: "ROLE_ASSIGNED",
        entityId: "role-1",
        entityType: "RoleAssignment",
        communityId: "c1",
        payload: {},
        status: "pending",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        createdAt: past,
        deliveredAt: null,
        nextRetryAt: past,
      },
    ]);

    const handler: OutboxEventHandler = async () => {
      throw new Error("Delivery failed");
    };

    const result = await processOutboxBatch(prisma, handler, 50);

    expect(result.processed).toBe(1);
    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(1);

    // Should have called markOutboxFailed, which updates retryCount + schedules retry
    const failUpdate = prisma._updated.find(
      (u: any) => u.where.id === "evt-fail" && u.data.retryCount === 1,
    );
    expect(failUpdate).toBeDefined();
    expect(failUpdate.data.lastError).toBe("Delivery failed");
    expect(failUpdate.data.nextRetryAt).toBeDefined();
  });

  test("handles retry exhaustion scenario (max retries reached)", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 1000);
    const prisma = makePrismaWithEvents([
      {
        id: "evt-exhausted",
        eventType: "RESOURCE_UPDATED",
        entityId: null,
        entityType: null,
        communityId: "c1",
        payload: {},
        status: "pending",
        retryCount: 4, // One retry left before permanent failure
        maxRetries: 5,
        lastError: "Previous failures",
        createdAt: past,
        deliveredAt: null,
        nextRetryAt: past,
      },
    ]);

    const handler: OutboxEventHandler = async () => {
      throw new Error("Still failing");
    };

    await processOutboxBatch(prisma, handler, 50);

    // Should be permanently failed now
    const failUpdate = prisma._updated.find(
      (u: any) => u.where.id === "evt-exhausted" && u.data.status === "failed",
    );
    expect(failUpdate).toBeDefined();
    expect(failUpdate.data.retryCount).toBe(5);
    expect(failUpdate.data.nextRetryAt).toBeNull();
  });

  test("empty batch returns zero counts", async () => {
    const prisma = makePrismaWithEvents([]);
    const handler: OutboxEventHandler = jest.fn();

    const result = await processOutboxBatch(prisma, handler, 50);

    expect(result.processed).toBe(0);
    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  test("respects batch size limit", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 1000);
    const events = Array.from({ length: 10 }, (_, i) => ({
      id: `evt-${i}`,
      eventType: "MEMBERSHIP_CREATED",
      entityId: null,
      entityType: null,
      communityId: "c1",
      payload: {},
      status: "pending",
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      createdAt: past,
      deliveredAt: null,
      nextRetryAt: past,
    }));

    const prisma = makePrismaWithEvents(events);
    const handler: OutboxEventHandler = jest.fn();

    const result = await processOutboxBatch(prisma, handler, 3);

    expect(result.processed).toBeLessThanOrEqual(3);
    expect(handler).toHaveBeenCalledTimes(result.processed);
  });
});

describe("createOutboxWorker", () => {
  test("start and stop lifecycle", () => {
    jest.useFakeTimers();

    const prisma = makePrismaWithEvents([]);
    const handler: OutboxEventHandler = jest.fn();

    const worker = createOutboxWorker(5000, handler, prisma as any, 10);

    // Start runs immediately, then schedules
    worker.start();

    // Fast-forward past the immediate run
    jest.advanceTimersByTime(100);

    // Stop should clear the timer
    worker.stop();

    jest.useRealTimers();
  });

  test("runOnce processes batch synchronously", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 1000);
    const prisma = makePrismaWithEvents([
      {
        id: "evt-once",
        eventType: "POLICY_CREATED",
        entityId: null,
        entityType: null,
        communityId: "c1",
        payload: {},
        status: "pending",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        createdAt: past,
        deliveredAt: null,
        nextRetryAt: past,
      },
    ]);

    const deliveredIds: string[] = [];
    const handler: OutboxEventHandler = async (event) => {
      deliveredIds.push(event.id);
    };

    const worker = createOutboxWorker(5000, handler, prisma as any, 10);
    const result = await worker.runOnce();

    expect(result.delivered).toBe(1);
    expect(deliveredIds).toContain("evt-once");
  });
});
