/**
 * outboxWorker.test.ts
 *
 * Tests for the outbox worker covering:
 *   - Processing pending events (via FOR UPDATE SKIP LOCKED)
 *   - Marking delivered on success
 *   - Marking failed on handler error
 *   - Retry state transitions through the worker
 *   - Adaptive batch sizing
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
    $queryRaw: jest.fn().mockResolvedValue([]),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock PrismaClient that feeds the given pending events to
 * $queryRaw (used by claimPendingOutboxEvents).
 */
function makePrismaWithEvents(pendingEvents: any[] = []) {
  const events = [...pendingEvents];
  const updated: Array<{ where: { id: string }; data: any }> = [];

  const prisma: any = {
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
    // Stub for claimPendingOutboxEvents' raw claim query (see
    // services/outboxService.test.ts for the same pattern, documented
    // there). Mutates `events` in place so a claimed row isn't reclaimed
    // until its lease elapses — mirroring the real UPDATE's atomicity.
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: any[]) => {
      const [workerId, leaseMs, limit] = values;
      const now = new Date();
      const eligible = events.filter(
        (r: any) =>
          r.status === "pending" &&
          r.nextRetryAt &&
          new Date(r.nextRetryAt) <= now &&
          (!r.claimExpiresAt || new Date(r.claimExpiresAt) < now),
      );
      eligible.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      const claimed = eligible.slice(0, limit);
      const claimExpiresAt = new Date(now.getTime() + leaseMs);
      claimed.forEach((r: any) => {
        r.claimedAt = now;
        r.claimedBy = workerId;
        r.claimExpiresAt = claimExpiresAt;
      });
      return claimed.map((r: any) => ({
        id: r.id,
        eventType: r.eventType,
        entityId: r.entityId,
        entityType: r.entityType,
        communityId: r.communityId,
        payload: r.payload,
        createdAt: r.createdAt,
      }));
    }),
    _updated: updated,
  };

  return prisma;
}

// ---------------------------------------------------------------------------
// Tests: processOutboxBatch
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
        retryCount: 4,
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

// ---------------------------------------------------------------------------
// Tests: createOutboxWorker
// ---------------------------------------------------------------------------

describe("createOutboxWorker", () => {
  test("start and stop lifecycle", () => {
    jest.useFakeTimers();

    const prisma = makePrismaWithEvents([]);
    const handler: OutboxEventHandler = jest.fn();

    const worker = createOutboxWorker({
      intervalMs: 5000,
      handler,
      db: prisma,
      maxBatchSize: 10,
    });

    worker.start();

    expect(worker.shards.length).toBe(1);

    jest.advanceTimersByTime(100);

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

    const worker = createOutboxWorker({
      intervalMs: 5000,
      handler,
      db: prisma,
      maxBatchSize: 10,
    });
    const result = await worker.runOnce();

    expect(result.delivered).toBe(1);
    expect(deliveredIds).toContain("evt-once");
  });

  test("supports multiple worker shards", () => {
    jest.useFakeTimers();

    const prisma = makePrismaWithEvents([]);
    const handler: OutboxEventHandler = jest.fn();

    const worker = createOutboxWorker({
      intervalMs: 5000,
      handler,
      db: prisma,
      maxBatchSize: 10,
      workerCount: 3,
    });

    worker.start();

    expect(worker.shards.length).toBe(3);
    expect(worker.shards[0].id).toBe(0);
    expect(worker.shards[1].id).toBe(1);
    expect(worker.shards[2].id).toBe(2);

    worker.stop();

    jest.useRealTimers();
  });

  test("start is idempotent (second call is a no-op)", () => {
    jest.useFakeTimers();

    const prisma = makePrismaWithEvents([]);
    const handler: OutboxEventHandler = jest.fn();

    const worker = createOutboxWorker({
      intervalMs: 5000,
      handler,
      db: prisma,
      maxBatchSize: 10,
      workerCount: 2,
    });

    worker.start();
    const shardCount1 = worker.shards.length;

    worker.start();
    const shardCount2 = worker.shards.length;

    expect(shardCount1).toBe(2);
    expect(shardCount2).toBe(2); // No additional shards on second start

    worker.stop();

    jest.useRealTimers();
  });
});
