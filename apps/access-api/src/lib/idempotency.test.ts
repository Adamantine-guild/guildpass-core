/**
 * idempotency.test.ts
 *
 * Unit tests for the Idempotency-Key middleware (issue #184):
 *   - No header → passthrough, no dedup
 *   - Same key + same payload replayed after completion → cached response,
 *     no second call to the wrapped handler / no second mutation
 *   - Same key + different payload → 409 Conflict
 *   - Concurrent duplicate insert (unique constraint race) → 409 Conflict
 *   - 5xx responses drop the pending row instead of caching the failure
 *
 * A hand-rolled Prisma mock is used (matching the style of
 * outboxService.test.ts) rather than a real Postgres instance, since the
 * behaviour under test is the middleware's control flow, not Postgres
 * locking semantics.
 */
import Fastify, { FastifyInstance } from "fastify";
import {
  createIdempotencyPreHandler,
  createIdempotencyOnSend,
  hashRequestBody,
} from "./idempotency";

function makeDb() {
  const rows = new Map<string, any>();
  let idCounter = 0;

  const db: any = {
    idempotencyKey: {
      findUnique: jest.fn(async ({ where }: any) => {
        const { key, route } = where.key_route;
        return rows.get(`${key}::${route}`) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const compositeKey = `${data.key}::${data.route}`;
        if (rows.has(compositeKey)) {
          const err: any = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        idCounter++;
        const record = {
          id: `idem-${idCounter}`,
          ...data,
          responseStatus: null,
          responseBody: null,
        };
        rows.set(compositeKey, record);
        return record;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const record = [...rows.values()].find((r) => r.id === where.id);
        if (!record) throw new Error("not found");
        Object.assign(record, data);
        return record;
      }),
      delete: jest.fn(async ({ where }: any) => {
        for (const [k, v] of rows.entries()) {
          if (v.id === where.id) rows.delete(k);
        }
      }),
    },
  };

  return { db, rows };
}

/** Builds a minimal Fastify app with one mutating route wrapping a spy. */
function buildApp(db: any, handlerSpy: jest.Mock) {
  const app = Fastify();
  const idempotencyPreHandler = createIdempotencyPreHandler(db);
  const idempotencyOnSend = createIdempotencyOnSend(db);

  app.post(
    "/v1/communities/:communityId/members/:wallet/roles",
    { preHandler: [idempotencyPreHandler], onSend: [idempotencyOnSend] },
    async (request, reply) => {
      handlerSpy(request.body);
      return reply.status(200).send({ assigned: true, role: "contributor" });
    },
  );

  app.post(
    "/v1/flaky",
    { preHandler: [idempotencyPreHandler], onSend: [idempotencyOnSend] },
    async (_request, reply) => {
      handlerSpy();
      return reply.status(500).send({ error: "boom" });
    },
  );

  return app;
}

describe("idempotency middleware", () => {
  let app: FastifyInstance;
  let handlerSpy: jest.Mock;
  let db: ReturnType<typeof makeDb>["db"];

  beforeEach(() => {
    handlerSpy = jest.fn();
    ({ db } = makeDb());
    app = buildApp(db, handlerSpy);
  });

  afterEach(async () => {
    await app.close();
  });

  it("passes requests through untouched when no Idempotency-Key header is sent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/communities/community-1/members/0xabc/roles",
      payload: { role: "contributor" },
    });
    expect(res.statusCode).toBe(200);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(db.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("executes the mutation once and returns the identical cached response on retry", async () => {
    const payload = { role: "contributor" };
    const headers = { "idempotency-key": "retry-key-1" };

    const first = await app.inject({
      method: "POST",
      url: "/v1/communities/community-1/members/0xabc/roles",
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(handlerSpy).toHaveBeenCalledTimes(1);

    // Simulate a client retry after a successful-but-unacknowledged response.
    const second = await app.inject({
      method: "POST",
      url: "/v1/communities/community-1/members/0xabc/roles",
      headers,
      payload,
    });

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
    // The handler (and therefore the underlying mutation / outbox event)
    // must only have run once.
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the same key is reused with a different payload", async () => {
    const headers = { "idempotency-key": "retry-key-2" };

    const first = await app.inject({
      method: "POST",
      url: "/v1/communities/community-1/members/0xabc/roles",
      headers,
      payload: { role: "contributor" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/v1/communities/community-1/members/0xabc/roles",
      headers,
      payload: { role: "admin" },
    });

    expect(second.statusCode).toBe(409);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 409 for a genuinely concurrent duplicate (unique constraint race)", async () => {
    const headers = { "idempotency-key": "retry-key-3" };
    const payload = { role: "contributor" };

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/communities/community-1/members/0xabc/roles",
        headers,
        payload,
      }),
      app.inject({
        method: "POST",
        url: "/v1/communities/community-1/members/0xabc/roles",
        headers,
        payload,
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    // Exactly one request succeeds; the other is told to back off.
    expect(statuses).toEqual([200, 409]);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cache a 5xx response, allowing a genuine re-attempt", async () => {
    const headers = { "idempotency-key": "retry-key-4" };

    const first = await app.inject({
      method: "POST",
      url: "/v1/flaky",
      headers,
      payload: {},
    });
    expect(first.statusCode).toBe(500);
    expect(handlerSpy).toHaveBeenCalledTimes(1);

    const second = await app.inject({
      method: "POST",
      url: "/v1/flaky",
      headers,
      payload: {},
    });
    expect(second.statusCode).toBe(500);
    // Handler re-runs because the failed attempt's pending row was dropped.
    expect(handlerSpy).toHaveBeenCalledTimes(2);
  });
});

describe("hashRequestBody", () => {
  it("is stable regardless of key ordering", () => {
    const a = hashRequestBody({ role: "admin", wallet: "0xabc" });
    const b = hashRequestBody({ wallet: "0xabc", role: "admin" });
    expect(a).toBe(b);
  });

  it("differs for different payloads", () => {
    const a = hashRequestBody({ role: "admin" });
    const b = hashRequestBody({ role: "contributor" });
    expect(a).not.toBe(b);
  });
});
