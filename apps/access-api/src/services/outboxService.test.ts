/**
 * outboxService.test.ts
 *
 * Unit tests for the outbox service covering:
 *   - Event creation (logOutboxEventTx)
 *   - Marking events as delivered
 *   - Marking events as failed with retry transitions
 *   - Pending event fetching
 *   - Stats and pruning
 */

import {
  logOutboxEventTx,
  markOutboxDelivered,
  markOutboxFailed,
  getPendingOutboxEvents,
  getOutboxStats,
  pruneDeliveredOutboxEvents,
} from "./outboxService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(overrides: any = {}) {
  const created: any[] = [];
  const updated: Array<{ where: { id: string }; data: any }> = [];
  let idCounter = 0;

  const db: any = {
    outboxEvent: {
      create: jest.fn(async (args: any) => {
        idCounter++;
        const record = {
          id: `evt-${idCounter}`,
          eventType: args.data.eventType ?? "UNKNOWN",
          entityId: args.data.entityId ?? null,
          entityType: args.data.entityType ?? null,
          communityId: args.data.communityId ?? null,
          payload: args.data.payload ?? {},
          status: args.data.status ?? "pending",
          retryCount: args.data.retryCount ?? 0,
          maxRetries: args.data.maxRetries ?? 5,
          lastError: null,
          createdAt: new Date(),
          deliveredAt: null,
          nextRetryAt: args.data.nextRetryAt ?? new Date(),
        };
        created.push(record);
        return record;
      }),
      update: jest.fn(async (args: any) => {
        updated.push(args);
        const existing = created.find((r) => r.id === args.where.id);
        if (existing) {
          Object.assign(existing, args.data);
          return existing;
        }
        return { id: args.where.id, ...args.data };
      }),
      findMany: jest.fn(async (args: any) => {
        // Return records matching the filter
        let results = [...created, ...(overrides.extraEvents ?? [])];
        if (args?.where?.status) {
          results = results.filter((r) => r.status === args.where.status);
        }
        if (args?.where?.nextRetryAt?.lte) {
          const cutoff = args.where.nextRetryAt.lte;
          results = results.filter(
            (r: any) => r.nextRetryAt && new Date(r.nextRetryAt) <= new Date(cutoff),
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
      count: jest.fn(async (args: any) => {
        let results = [...created, ...(overrides.extraEvents ?? [])];
        if (args?.where?.status) {
          results = results.filter((r) => r.status === args.where.status);
        }
        return results.length;
      }),
      ...overrides,
    },
  };

  return { db, created, updated };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("logOutboxEventTx", () => {
  test("creates a pending outbox event with correct fields", async () => {
    const { db, created } = makeDb();

    const result = await logOutboxEventTx(db, {
      eventType: "RESOURCE_CREATED",
      entityId: "res-1",
      entityType: "Resource",
      communityId: "community-1",
      payload: { name: "Test Resource" },
    });

    expect(result.status).toBe("pending");
    expect(result.eventId).toBe("evt-1");

    expect(db.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "RESOURCE_CREATED",
        entityId: "res-1",
        entityType: "Resource",
        communityId: "community-1",
        payload: { name: "Test Resource" },
        status: "pending",
        retryCount: 0,
        maxRetries: 5,
        nextRetryAt: expect.any(Date),
      }),
    });

    expect(created[0].status).toBe("pending");
    expect(created[0].retryCount).toBe(0);
  });

  test("sets eligible nextRetryAt to now for immediate processing", async () => {
    const { db } = makeDb();
    const before = Date.now();

    await logOutboxEventTx(db, {
      eventType: "MEMBERSHIP_UPDATED",
      communityId: "community-1",
    });

    const callData = (db.outboxEvent.create as jest.Mock).mock.calls[0][0].data;
    const nextRetryAt = new Date(callData.nextRetryAt).getTime();
    const after = Date.now();

    // Should be within a reasonable window
    expect(nextRetryAt).toBeGreaterThanOrEqual(before - 1000);
    expect(nextRetryAt).toBeLessThanOrEqual(after + 1000);
  });
});

describe("markOutboxDelivered", () => {
  test("marks event as delivered with timestamp", async () => {
    const { db } = makeDb();
    // First create an event
    await logOutboxEventTx(db, {
      eventType: "POLICY_CREATED",
      communityId: "community-1",
    });

    await markOutboxDelivered(db, "evt-1");

    expect(db.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: {
        status: "delivered",
        deliveredAt: expect.any(Date),
        nextRetryAt: null,
      },
    });
  });
});

describe("markOutboxFailed", () => {
  test("schedules retry on first failure with exponential backoff", async () => {
    const { db } = makeDb();
    await logOutboxEventTx(db, {
      eventType: "ROLE_ASSIGNED",
      communityId: "community-1",
    });

    const before = Date.now();
    await markOutboxFailed(db, "evt-1", "Connection timeout");
    const after = Date.now();

    const updateCall = (db.outboxEvent.update as jest.Mock).mock.calls[0][0];

    expect(updateCall.where).toEqual({ id: "evt-1" });
    expect(updateCall.data.retryCount).toBe(1);
    expect(updateCall.data.lastError).toBe("Connection timeout");
    // First retry: 10 * 2^1 = 20 seconds
    const nextRetryAt = new Date(updateCall.data.nextRetryAt).getTime();
    const expectedMin = before + 19_000; // allow 1s tolerance
    const expectedMax = after + 21_000;
    expect(nextRetryAt).toBeGreaterThanOrEqual(expectedMin);
    expect(nextRetryAt).toBeLessThanOrEqual(expectedMax);
    // Status should remain pending (not permanent failure yet)
    expect(updateCall.data.status).toBeUndefined();
  });

  test("marks as permanently failed after max retries", async () => {
    const extraEvents = [
      {
        id: "evt-prefailed",
        eventType: "ROLE_REMOVED",
        entityId: null,
        entityType: null,
        communityId: "community-1",
        payload: {},
        status: "pending",
        retryCount: 4,
        maxRetries: 5,
        lastError: "prev error",
        createdAt: new Date(),
        deliveredAt: null,
        nextRetryAt: new Date(),
      },
    ];
    const { db } = makeDb({ extraEvents });

    await markOutboxFailed(db, "evt-prefailed", "Final failure");

    const updateCall = (db.outboxEvent.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.status).toBe("failed");
    expect(updateCall.data.retryCount).toBe(5);
    expect(updateCall.data.nextRetryAt).toBeNull();
  });

  test("retryCount increments correctly across multiple failures", async () => {
    const extraEvents = [
      {
        id: "evt-multi",
        eventType: "RESOURCE_UPDATED",
        entityId: null,
        entityType: null,
        communityId: "community-1",
        payload: {},
        status: "pending",
        retryCount: 2,
        maxRetries: 5,
        lastError: "error 2",
        createdAt: new Date(),
        deliveredAt: null,
        nextRetryAt: new Date(),
      },
    ];
    const { db } = makeDb({ extraEvents });

    await markOutboxFailed(db, "evt-multi", "error 3");

    const updateCall = (db.outboxEvent.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.retryCount).toBe(3);
    // Fourth retry delay: 10 * 2^3 = 80 seconds
    const nextRetryAt = new Date(updateCall.data.nextRetryAt).getTime();
    const expectedMin = Date.now() + 79_000;
    const expectedMax = Date.now() + 81_000;
    expect(nextRetryAt).toBeGreaterThanOrEqual(expectedMin);
    expect(nextRetryAt).toBeLessThanOrEqual(expectedMax);
  });

  test("does not throw for non-existent event ID", async () => {
    const { db } = makeDb();

    await expect(
      markOutboxFailed(db, "nonexistent", "error"),
    ).resolves.toEqual({ permanentlyFailed: false, retryCount: 0 });
  });
});

describe("getPendingOutboxEvents", () => {
  test("returns only pending events whose nextRetryAt is in the past", async () => {
    const now = new Date();
    const pastDate = new Date(now.getTime() - 60_000); // 1 min ago
    const futureDate = new Date(now.getTime() + 60_000); // 1 min from now

    const extraEvents = [
      {
        id: "evt-eligible",
        eventType: "RESOURCE_CREATED",
        entityId: null,
        entityType: null,
        communityId: "c1",
        payload: {},
        status: "pending",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        createdAt: pastDate,
        deliveredAt: null,
        nextRetryAt: pastDate,
      },
      {
        id: "evt-future",
        eventType: "RESOURCE_CREATED",
        entityId: null,
        entityType: null,
        communityId: "c1",
        payload: {},
        status: "pending",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        createdAt: now,
        deliveredAt: null,
        nextRetryAt: futureDate,
      },
      {
        id: "evt-delivered",
        eventType: "RESOURCE_CREATED",
        entityId: null,
        entityType: null,
        communityId: "c1",
        payload: {},
        status: "delivered",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        createdAt: now,
        deliveredAt: now,
        nextRetryAt: null,
      },
    ];

    const { db } = makeDb({ extraEvents });

    const results = await getPendingOutboxEvents(db, 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Only evt-eligible should be returned
    const ids = results.map((r: any) => r.id);
    expect(ids).toContain("evt-eligible");
    expect(ids).not.toContain("evt-future");
    expect(ids).not.toContain("evt-delivered");
  });

  test("orders results by createdAt ascending", async () => {
    const now = new Date();
    const pastDate = new Date(now.getTime() - 120_000);
    const midDate = new Date(now.getTime() - 60_000);

    const extraEvents = [
      {
        id: "evt-older",
        eventType: "MEMBERSHIP_UPDATED",
        entityId: null,
        entityType: null,
        communityId: "c1",
        payload: {},
        status: "pending",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        createdAt: pastDate,
        deliveredAt: null,
        nextRetryAt: pastDate,
      },
      {
        id: "evt-newer",
        eventType: "MEMBERSHIP_CREATED",
        entityId: null,
        entityType: null,
        communityId: "c1",
        payload: {},
        status: "pending",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        createdAt: midDate,
        deliveredAt: null,
        nextRetryAt: midDate,
      },
    ];

    const { db } = makeDb({ extraEvents });

    const results = await getPendingOutboxEvents(db, 10);
    const pendingResults = results.filter((r: any) =>
      extraEvents.some((e) => e.id === r.id),
    );
    expect(pendingResults[0].id).toBe("evt-older");
    expect(pendingResults[1].id).toBe("evt-newer");
  });
});

describe("getOutboxStats", () => {
  test("returns correct counts by status", async () => {
    const extraEvents = [
      {
        id: "evt-1",
        eventType: "RESOURCE_CREATED",
        entityId: null,
        entityType: null,
        communityId: "c1",
        payload: {},
        status: "pending",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        createdAt: new Date(),
        deliveredAt: null,
        nextRetryAt: new Date(),
      },
      {
        id: "evt-2",
        eventType: "RESOURCE_UPDATED",
        entityId: null,
        entityType: null,
        communityId: "c1",
        payload: {},
        status: "pending",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        createdAt: new Date(),
        deliveredAt: null,
        nextRetryAt: new Date(),
      },
      {
        id: "evt-3",
        eventType: "RESOURCE_ARCHIVED",
        entityId: null,
        entityType: null,
        communityId: "c1",
        payload: {},
        status: "delivered",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        createdAt: new Date(),
        deliveredAt: new Date(),
        nextRetryAt: null,
      },
      {
        id: "evt-4",
        eventType: "ROLE_ASSIGNED",
        entityId: null,
        entityType: null,
        communityId: "c1",
        payload: {},
        status: "failed",
        retryCount: 5,
        maxRetries: 5,
        lastError: "permanent failure",
        createdAt: new Date(),
        deliveredAt: null,
        nextRetryAt: null,
      },
    ];

    const { db } = makeDb({ extraEvents });

    const stats = await getOutboxStats(db);

    expect(stats.pending).toBe(2);
    expect(stats.delivered).toBe(1);
    expect(stats.failed).toBe(1);
  });
});

describe("pruneDeliveredOutboxEvents", () => {
  test("calls deleteMany on delivered events older than cutoff", async () => {
    const { db } = makeDb();
    const deleteManyMock = jest.fn().mockResolvedValue({ count: 5 });
    (db.outboxEvent as any).deleteMany = deleteManyMock;
    const cutoff = new Date("2026-06-22");

    const count = await pruneDeliveredOutboxEvents(db, cutoff);

    expect(deleteManyMock).toHaveBeenCalledWith({
      where: {
        status: "delivered",
        deliveredAt: { lt: cutoff },
      },
    });
    expect(count).toBe(5);
  });
});
