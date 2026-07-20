/**
 * outboxWorker.concurrency.test.ts
 *
 * The core acceptance test for issue #94 (distributed locking for
 * multi-instance outbox worker deployments): runs two independent
 * `createOutboxWorker` instances against the *same real Postgres database*
 * and asserts the guarantees a mocked Prisma client cannot exercise —
 * `SELECT ... FOR UPDATE SKIP LOCKED` row-level locking only means anything
 * against a real database's lock manager.
 *
 * Requires DATABASE_URL to point at a real Postgres instance with the
 * current schema applied (see INTEGRATION_TEST_GUIDE.md), matching the
 * existing real-DB integration tests (test/crossCommunityLeakage.test.ts,
 * src/membership-integration.test.ts).
 *
 * Determinism note: every assertion here is on a *fully drained* queue
 * (batch sizes sized comfortably larger than the seeded event count, so a
 * single pass claims everything) — there is no reliance on wall-clock
 * timing except in the lease-expiry tests, which use a short, explicit
 * lease and an explicit wait for it to elapse rather than a race.
 *
 * Isolation note: all rows this file creates use the fixed
 * SUITE_COMMUNITY_ID below, and cleanup/assertions are scoped to it, so
 * this suite never touches or is confused by another suite's rows sharing
 * this same OutboxEvent table (the claim query itself has no communityId
 * filter — see SUITE_COMMUNITY_ID's comment). This does NOT make the suite
 * fully immune to interference from parallel Jest workers: it only
 * protects against *this* file's own actions, not another file's unscoped
 * `outboxEvent.deleteMany({})` (src/membership-integration.test.ts has
 * one). See the PR description for that known, pre-existing gap.
 */

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createOutboxWorker, OutboxEventHandler } from "../src/workers/outboxWorker";
import { claimPendingOutboxEvents, ClaimedOutboxEvent } from "../src/services/outboxService";

const prisma = new PrismaClient();

// Unique to this suite, used both to scope this file's own cleanup (so it
// never touches rows other test files own) and to filter this file's
// in-process assertions. claimPendingOutboxEvents has no communityId
// filter — matching the pre-#94 getPendingOutboxEvents, intentionally, see
// outboxService.ts — so a worker claiming a batch during this test can
// still pick up unrelated pending rows another suite happens to have in
// flight at the same moment. Filtering every in-process assertion down to
// this communityId keeps the test correct regardless of that. It does NOT
// protect against another suite's *unscoped* `outboxEvent.deleteMany({})`
// (see src/membership-integration.test.ts's "Audit Chain of Custody
// Integration" describe block) — that deletes this suite's rows too, with
// no WHERE clause for any tag to except itself from. See this file's
// header comment and the PR description for that known gap.
const SUITE_COMMUNITY_ID = "concurrency-test";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function belongsToSuite(event: ClaimedOutboxEvent): boolean {
  return event.communityId === SUITE_COMMUNITY_ID;
}

/**
 * Seed `count` immediately-due pending OutboxEvent rows and return their ids
 * in creation order.
 *
 * createdAt is set explicitly, one full second apart per row, instead of
 * relying on `now()` at insert time: createdAt has only millisecond
 * resolution, so a tight seeding loop can produce ties, and the claim
 * query's `ORDER BY createdAt ASC` has no guaranteed tiebreaker for rows
 * that collide on it (this is inherent to timestamp-based ordering and
 * predates this change). Spacing them out here makes the *test* fully
 * deterministic without changing that production behavior.
 */
async function seedPendingEvents(count: number, tag: string): Promise<string[]> {
  const base = Date.now() - 1000 - count * 1000;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const event = await prisma.outboxEvent.create({
      data: {
        eventType: "RESOURCE_CREATED",
        entityId: `${tag}-${i}`,
        entityType: "Resource",
        communityId: SUITE_COMMUNITY_ID,
        payload: { tag, i },
        status: "pending",
        createdAt: new Date(base + i * 1000),
        nextRetryAt: new Date(base + i * 1000),
      },
    });
    ids.push(event.id);
  }
  return ids;
}

// Scoped to this suite's own communityId — see SUITE_COMMUNITY_ID above for
// why this only protects rows this file owns, not the other direction.
beforeEach(async () => {
  await prisma.outboxEvent.deleteMany({ where: { communityId: SUITE_COMMUNITY_ID } });
});

afterAll(async () => {
  await prisma.outboxEvent.deleteMany({ where: { communityId: SUITE_COMMUNITY_ID } });
  await prisma.$disconnect();
});

describe("Two-instance outbox worker concurrency", () => {
  test(
    "every seeded event is delivered exactly once across two concurrent workers, none left pending",
    async () => {
      // Scale note: this count and the batch sizes below are not arbitrary.
      // A single claim is one atomic `UPDATE ... RETURNING` statement, so the
      // window in which two workers' claims can genuinely overlap is however
      // long that one statement takes to execute server-side — at a handful
      // of rows that's sub-millisecond, and two workers' claims dispatched
      // via Promise.all essentially never land inside it (verified: at
      // 30 events / batch 30, the duplicate-delivery assertions below passed
      // 6/6 times even with `FOR UPDATE SKIP LOCKED` removed from the claim
      // query — a worthless test that would never catch a regression).
      // Seeding 2000 events with both workers requesting an overlapping 1200
      // each (2400 > 2000, so disjoint claims are only possible if the
      // locking actually works) makes each claim statement's execution long
      // enough, and the requested ranges overlapping enough, that genuine
      // contention is reliable: re-verified at this scale with locking
      // removed, all 5/5 trials failed with duplicates (up to 1200 of them).
      const ids = await seedPendingEvents(2000, "exactly-once");

      // Handlers only track rows that belong to this suite: the claim query
      // has no communityId scope (matching the pre-#94 getPendingOutboxEvents,
      // intentionally — see claimPendingOutboxEvents), so a worker here could
      // in principle also claim an unrelated pending row another suite has
      // in flight at the same moment. Filtering here keeps the exact-set
      // assertions below correct regardless of that, without changing the
      // claim query's production semantics.
      const deliveredByWorkerA: string[] = [];
      const deliveredByWorkerB: string[] = [];
      const handlerA: OutboxEventHandler = async (event) => {
        if (event.communityId === SUITE_COMMUNITY_ID) deliveredByWorkerA.push(event.id);
      };
      const handlerB: OutboxEventHandler = async (event) => {
        if (event.communityId === SUITE_COMMUNITY_ID) deliveredByWorkerB.push(event.id);
      };

      const workerA = createOutboxWorker({
        intervalMs: 60_000,
        handler: handlerA,
        db: prisma,
        maxBatchSize: 1200,
        workerId: "worker-A",
      });
      const workerB = createOutboxWorker({
        intervalMs: 60_000,
        handler: handlerB,
        db: prisma,
        maxBatchSize: 1200,
        workerId: "worker-B",
      });

      const [resultA, resultB] = await Promise.all([
        workerA.runOnce(),
        workerB.runOnce(),
      ]);

      // Termination: Promise.all resolved at all (no deadlock/livelock) —
      // if SKIP LOCKED were missing and workers blocked on each other's row
      // locks instead of skipping them, this would hang and fail on Jest's
      // test timeout instead of reaching this line. `processed` here counts
      // every row each worker claimed, including any unrelated row from
      // another suite it happened to pick up (see the handler comment
      // above) — so this is a lower bound, not an exact-2000 check; the
      // exact-set checks below (allDelivered, and the DB-level counts
      // scoped to SUITE_COMMUNITY_ID) are what actually prove all 2000 of
      // ours were delivered exactly once.
      expect(resultA.processed + resultB.processed).toBeGreaterThanOrEqual(2000);

      const allDelivered = [...deliveredByWorkerA, ...deliveredByWorkerB];

      // (a) exactly once: no duplicates across the two workers' delivery logs
      expect(new Set(allDelivered).size).toBe(allDelivered.length);

      // (b) zero unprocessed: the exact multiset of seeded ids was delivered,
      // split across the two workers, no more and no less
      expect(allDelivered.sort()).toEqual([...ids].sort());

      // No worker delivered the other's rows twice, and no row was skipped
      const stillPending = await prisma.outboxEvent.count({
        where: { communityId: SUITE_COMMUNITY_ID, status: "pending" },
      });
      expect(stillPending).toBe(0);

      const delivered = await prisma.outboxEvent.count({
        where: { communityId: SUITE_COMMUNITY_ID, status: "delivered" },
      });
      expect(delivered).toBe(2000);
    },
    60_000,
  );

  test(
    "a worker that crashes mid-batch leaves its claimed events reclaimable once the lease expires",
    async () => {
      const [eventId] = await seedPendingEvents(1, "crash-recovery");
      const shortLeaseMs = 200;

      // Simulate "worker A claims a batch, then the process dies before it
      // can call markOutboxDelivered/markOutboxFailed" by claiming directly
      // and never finishing the pass.
      const claimed = await claimPendingOutboxEvents(prisma as any, 10, "worker-dead", shortLeaseMs);
      expect(claimed.map((e) => e.id)).toContain(eventId);

      // While the lease is still live, a second worker must NOT see it.
      const tooEarly = await claimPendingOutboxEvents(prisma as any, 10, "worker-B", 60_000);
      expect(tooEarly.map((e) => e.id)).not.toContain(eventId);

      // Wait past the short lease.
      await sleep(shortLeaseMs + 100);

      // Filtered to this suite's own rows for the same reason as the
      // two-worker test above: the claim query has no communityId scope.
      const delivered: string[] = [];
      const handler: OutboxEventHandler = async (event) => {
        if (event.communityId === SUITE_COMMUNITY_ID) delivered.push(event.id);
      };
      const workerB = createOutboxWorker({
        intervalMs: 60_000,
        handler,
        db: prisma,
        maxBatchSize: 10,
        workerId: "worker-B",
      });
      const result = await workerB.runOnce();

      expect(result.delivered).toBeGreaterThanOrEqual(1);
      expect(delivered).toEqual([eventId]);

      const row = await prisma.outboxEvent.findUnique({ where: { id: eventId } });
      expect(row?.status).toBe("delivered");
    },
    15_000,
  );

  test(
    "a live (unexpired) lease is not stolen by another worker",
    async () => {
      const [eventId] = await seedPendingEvents(1, "live-lease");

      const claimed = await claimPendingOutboxEvents(prisma as any, 10, "worker-A", 60_000);
      expect(claimed.map((e) => e.id)).toContain(eventId);

      // Immediately attempt to claim from a second worker — the lease is
      // 60s, well beyond this test's runtime, so it must not be stolen.
      const stolen = await claimPendingOutboxEvents(prisma as any, 10, "worker-B", 60_000);
      expect(stolen.map((e) => e.id)).not.toContain(eventId);

      const row = await prisma.outboxEvent.findUnique({ where: { id: eventId } });
      expect(row?.claimedBy).toBe("worker-A");
      expect(row?.status).toBe("pending"); // still pending — claimed, not yet delivered
    },
    10_000,
  );

  test(
    "single-instance behavior is unchanged: one worker still delivers its whole batch in order",
    async () => {
      const ids = await seedPendingEvents(10, "single-instance");

      // Filtered to this suite's own rows for the same reason as the
      // two-worker test above: with batch size 50 and only 10 seeded here,
      // this worker has room to also claim an unrelated pending row from
      // another suite, which would otherwise break the strict order check
      // below.
      const delivered: string[] = [];
      const handler: OutboxEventHandler = async (event) => {
        if (event.communityId === SUITE_COMMUNITY_ID) delivered.push(event.id);
      };
      const worker = createOutboxWorker({
        intervalMs: 60_000,
        handler,
        db: prisma,
        maxBatchSize: 50,
        workerId: `solo-${randomUUID()}`,
      });
      const result = await worker.runOnce();

      expect(result.errors).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.delivered).toBeGreaterThanOrEqual(10);
      // A single worker with no concurrent competitor still delivers this
      // suite's own rows in strict createdAt order, same as before this
      // change.
      expect(delivered).toEqual(ids);
    },
    15_000,
  );
});
