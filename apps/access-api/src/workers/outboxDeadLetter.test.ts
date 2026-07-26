/**
 * outboxDeadLetter.test.ts
 *
 * Integration-style test wiring the real outboxService + deadLetterService
 * logic through processOutboxBatch, covering the "dead-letter fallback
 * after repeated failure" acceptance criterion: an event that keeps
 * failing delivery is NOT silently dropped once retries are exhausted —
 * it lands in the dead-letter store, retrievable via listDeadLetterEvents.
 *
 * Uses a single in-memory fake Prisma client (shared between outboxEvent
 * and deadLetterEvent) so markOutboxFailed and recordDeadLetter really do
 * observe and mutate the same state a real database would.
 */

import { processOutboxBatch } from "./outboxWorker";
import { listDeadLetterEvents } from "../services/deadLetterService";

function makeFakeDb(event: any) {
  const outboxEvents = [event];
  const deadLetters: any[] = [];

  return {
    outboxEvent: {
      findMany: jest.fn(async (args: any) => {
        let results = [...outboxEvents];
        if (args?.where?.status) {
          results = results.filter((r) => r.status === args.where.status);
        }
        if (args?.where?.nextRetryAt?.lte) {
          const cutoff = args.where.nextRetryAt.lte;
          results = results.filter(
            (r) => r.nextRetryAt && new Date(r.nextRetryAt) <= new Date(cutoff),
          );
        }
        if (args?.take != null) results = results.slice(0, args.take);
        return results;
      }),
      update: jest.fn(async (args: any) => {
        const existing = outboxEvents.find((e) => e.id === args.where.id);
        if (existing) Object.assign(existing, args.data);
        return existing;
      }),
      create: jest.fn(),
    },
    deadLetterEvent: {
      create: jest.fn(async (args: any) => {
        const record = { id: `dl-${deadLetters.length + 1}`, ...args.data };
        deadLetters.push(record);
        return record;
      }),
      findMany: jest.fn(async (args: any = {}) => {
        let results = [...deadLetters];
        if (args.where?.communityId) results = results.filter((r) => r.communityId === args.where.communityId);
        return results;
      }),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(async () => deadLetters.length),
    },
    // Stub for claimPendingOutboxEvents' raw claim query (see
    // outboxWorker.test.ts / outboxService.test.ts for the same pattern).
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: any[]) => {
      const [workerId, leaseMs, limit] = values;
      const now = new Date();
      const eligible = outboxEvents.filter(
        (r: any) =>
          r.status === "pending" &&
          r.nextRetryAt &&
          new Date(r.nextRetryAt) <= now &&
          (!r.claimExpiresAt || new Date(r.claimExpiresAt) < now),
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
    _outboxEvents: outboxEvents,
    _deadLetters: deadLetters,
  } as any;
}

describe("dead-letter fallback after repeated failure", () => {
  test("an event is not dead-lettered while retries remain", async () => {
    const past = new Date(Date.now() - 1000);
    const db = makeFakeDb({
      id: "evt-flaky",
      eventType: "MEMBERSHIP_CREATED",
      entityId: "mem-1",
      entityType: "Member",
      communityId: "community-1",
      payload: {},
      status: "pending",
      retryCount: 0,
      maxRetries: 3,
      lastError: null,
      createdAt: past,
      deliveredAt: null,
      nextRetryAt: past,
    });

    const alwaysFails = async () => {
      throw new Error("endpoint down");
    };

    await processOutboxBatch(db, alwaysFails, 50);

    expect(db._outboxEvents[0].status).toBe("pending"); // still retrying
    expect(db._deadLetters).toHaveLength(0);
  });

  test("an event that exhausts all retries is captured in the dead-letter store", async () => {
    const past = new Date(Date.now() - 1000);
    const db = makeFakeDb({
      id: "evt-flaky",
      eventType: "MEMBERSHIP_CREATED",
      entityId: "mem-1",
      entityType: "Member",
      communityId: "community-1",
      payload: { wallet: "0xabc" },
      status: "pending",
      retryCount: 0,
      maxRetries: 3,
      lastError: null,
      createdAt: past,
      deliveredAt: null,
      nextRetryAt: past,
    });

    const alwaysFails = async () => {
      throw new Error("endpoint down");
    };

    // Simulate three worker passes, each one a "retry". markOutboxFailed
    // schedules nextRetryAt in the future (exponential backoff), so between
    // passes we fast-forward it back into the past — standing in for "the
    // scheduled retry time has now arrived" without needing fake timers.
    // The backoff delay math itself is covered by outboxService.test.ts;
    // this test only asserts the retryCount/status transition and the
    // resulting dead-letter capture.
    await processOutboxBatch(db, alwaysFails, 50);
    db._outboxEvents[0].nextRetryAt = past;
    await processOutboxBatch(db, alwaysFails, 50);
    db._outboxEvents[0].nextRetryAt = past;
    await processOutboxBatch(db, alwaysFails, 50);

    expect(db._outboxEvents[0].status).toBe("failed");
    expect(db._outboxEvents[0].retryCount).toBe(3);

    const deadLetters = await listDeadLetterEvents(db, { communityId: "community-1" });
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      originalEventId: "evt-flaky",
      eventType: "MEMBERSHIP_CREATED",
      communityId: "community-1",
      failureReason: "endpoint down",
      retryCount: 3,
      status: "pending",
    });
  });

  test("a permanently failed event is only dead-lettered once, not on every subsequent worker pass", async () => {
    const past = new Date(Date.now() - 1000);
    const db = makeFakeDb({
      id: "evt-flaky",
      eventType: "ROLE_ASSIGNED",
      entityId: null,
      entityType: null,
      communityId: "community-1",
      payload: {},
      status: "pending",
      retryCount: 0,
      maxRetries: 1,
      lastError: null,
      createdAt: past,
      deliveredAt: null,
      nextRetryAt: past,
    });

    const alwaysFails = async () => {
      throw new Error("still down");
    };

    await processOutboxBatch(db, alwaysFails, 50); // exhausts the single retry -> dead-lettered
    // A subsequent worker pass should no longer pick this event up at all,
    // since claimPendingOutboxEvents only selects status="pending" rows.
    await processOutboxBatch(db, alwaysFails, 50);

    const deadLetters = await listDeadLetterEvents(db, { communityId: "community-1" });
    expect(deadLetters).toHaveLength(1);
  });
});
