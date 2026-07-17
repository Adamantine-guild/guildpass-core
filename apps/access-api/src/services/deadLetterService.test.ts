/**
 * deadLetterService.test.ts
 *
 * Unit tests for the dead-letter store covering:
 *   - Recording a permanently-failed outbox event
 *   - Listing with community/status filters
 *   - Manually retrying a dead-lettered event (re-enqueue + mark resolved)
 *   - Error paths: unknown id, already-resolved id
 */

import {
  recordDeadLetter,
  listDeadLetterEvents,
  retryDeadLetterEvent,
  DeadLetterNotFoundError,
  DeadLetterAlreadyResolvedError,
} from "./deadLetterService";

function makeDb(seed: any[] = []) {
  const deadLetters = [...seed];
  const outboxEvents: any[] = [];
  let idCounter = 0;

  return {
    deadLetterEvent: {
      create: jest.fn(async (args: any) => {
        idCounter++;
        const record = { id: `dl-${idCounter}`, resolvedAt: null, ...args.data };
        deadLetters.push(record);
        return record;
      }),
      findMany: jest.fn(async (args: any = {}) => {
        let results = [...deadLetters];
        if (args.where?.communityId) {
          results = results.filter((r) => r.communityId === args.where.communityId);
        }
        if (args.where?.status) {
          results = results.filter((r) => r.status === args.where.status);
        }
        if (args.take != null) results = results.slice(0, args.take);
        return results;
      }),
      findUnique: jest.fn(async (args: any) => deadLetters.find((r) => r.id === args.where.id) ?? null),
      update: jest.fn(async (args: any) => {
        const existing = deadLetters.find((r) => r.id === args.where.id);
        if (existing) Object.assign(existing, args.data);
        return existing;
      }),
      count: jest.fn(async () => deadLetters.length),
    },
    outboxEvent: {
      create: jest.fn(async (args: any) => {
        const record = { id: `evt-new-${outboxEvents.length + 1}`, ...args.data };
        outboxEvents.push(record);
        return record;
      }),
    },
    _deadLetters: deadLetters,
    _outboxEvents: outboxEvents,
  } as any;
}

describe("recordDeadLetter", () => {
  test("stores a pending dead-letter row from the failed outbox event", async () => {
    const db = makeDb();

    const result = await recordDeadLetter(db, {
      id: "evt-1",
      eventType: "MEMBERSHIP_CREATED",
      entityId: "mem-1",
      entityType: "Member",
      communityId: "community-1",
      payload: { wallet: "0xabc" },
      lastError: "endpoint responded with HTTP 500",
      retryCount: 5,
    });

    expect(result.id).toBeDefined();
    expect(db._deadLetters).toHaveLength(1);
    expect(db._deadLetters[0]).toMatchObject({
      originalEventId: "evt-1",
      eventType: "MEMBERSHIP_CREATED",
      communityId: "community-1",
      failureReason: "endpoint responded with HTTP 500",
      retryCount: 5,
      status: "pending",
    });
  });

  test("falls back to a generic failure reason when lastError is null", async () => {
    const db = makeDb();

    await recordDeadLetter(db, {
      id: "evt-2",
      eventType: "ROLE_ASSIGNED",
      entityId: null,
      entityType: null,
      communityId: null,
      payload: {},
      lastError: null,
      retryCount: 5,
    });

    expect(db._deadLetters[0].failureReason).toBe("Unknown delivery error");
  });
});

describe("listDeadLetterEvents", () => {
  test("filters by communityId and status", async () => {
    const db = makeDb([
      { id: "dl-1", communityId: "c1", status: "pending", createdAt: new Date() },
      { id: "dl-2", communityId: "c2", status: "pending", createdAt: new Date() },
      { id: "dl-3", communityId: "c1", status: "retried", createdAt: new Date() },
    ]);

    const filtered = await listDeadLetterEvents(db, { communityId: "c1", status: "pending" });
    expect(filtered.map((d: any) => d.id)).toEqual(["dl-1"]);
  });

  test("respects the limit parameter", async () => {
    const db = makeDb([
      { id: "dl-1", status: "pending", createdAt: new Date() },
      { id: "dl-2", status: "pending", createdAt: new Date() },
      { id: "dl-3", status: "pending", createdAt: new Date() },
    ]);

    const results = await listDeadLetterEvents(db, {}, 2);
    expect(results).toHaveLength(2);
  });
});

describe("retryDeadLetterEvent", () => {
  test("re-enqueues a fresh pending outbox event and marks the dead-letter as retried", async () => {
    const db = makeDb([
      {
        id: "dl-1",
        originalEventId: "evt-1",
        eventType: "MEMBERSHIP_CREATED",
        entityId: "mem-1",
        entityType: "Member",
        communityId: "community-1",
        payload: { wallet: "0xabc" },
        status: "pending",
      },
    ]);

    const result = await retryDeadLetterEvent(db, "dl-1");

    expect(result.newEventId).toBeDefined();
    expect(db._outboxEvents).toHaveLength(1);
    expect(db._outboxEvents[0]).toMatchObject({
      eventType: "MEMBERSHIP_CREATED",
      communityId: "community-1",
      status: "pending",
      retryCount: 0,
    });
    expect(db._deadLetters[0].status).toBe("retried");
    expect(db._deadLetters[0].resolvedAt).not.toBeNull();
  });

  test("throws DeadLetterNotFoundError for an unknown id", async () => {
    const db = makeDb([]);
    await expect(retryDeadLetterEvent(db, "does-not-exist")).rejects.toThrow(DeadLetterNotFoundError);
  });

  test("throws DeadLetterAlreadyResolvedError when retried twice", async () => {
    const db = makeDb([
      { id: "dl-1", eventType: "MEMBERSHIP_CREATED", communityId: "c1", payload: {}, status: "retried" },
    ]);

    await expect(retryDeadLetterEvent(db, "dl-1")).rejects.toThrow(DeadLetterAlreadyResolvedError);
  });
});
