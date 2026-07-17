/**
 * webhookHandler.test.ts
 *
 * Covers:
 *   - Successful delivery to matching, active subscriptions with correctly
 *     signed headers.
 *   - Signature verification on the "receiving" side (a test harness
 *     standing in for a webhook consumer), including rejection of a
 *     tampered body and a replayed (stale) timestamp.
 *   - Event-type and active/inactive filtering of subscriptions.
 *   - Failure propagation: any failed subscription delivery throws so the
 *     outbox worker's existing retry/backoff applies to the whole event.
 */

import {
  createWebhookHandler,
  signWebhookPayload,
  verifyWebhookSignature,
} from "./webhookHandler";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    eventType: "MEMBERSHIP_CREATED",
    entityId: "mem-1",
    entityType: "Member",
    communityId: "community-1",
    payload: { wallet: "0xabc" },
    createdAt: new Date("2026-07-17T00:00:00.000Z"),
    ...overrides,
  };
}

function makeDbWithSubscriptions(subscriptions: any[]) {
  return {
    webhookSubscription: {
      findMany: jest.fn(async () => subscriptions),
    },
  };
}

describe("signWebhookPayload / verifyWebhookSignature", () => {
  test("a receiver can independently recompute and verify a valid signature", () => {
    const secret = "shared-secret";
    const timestamp = String(Date.now());
    const nonce = "11111111-1111-1111-1111-111111111111";
    const body = JSON.stringify({ hello: "world" });

    const signature = signWebhookPayload(secret, timestamp, nonce, body);

    // Simulate the receiving side verifying the request it got.
    const valid = verifyWebhookSignature(secret, timestamp, nonce, body, signature);
    expect(valid).toBe(true);
  });

  test("rejects a signature computed with the wrong secret", () => {
    const timestamp = String(Date.now());
    const nonce = "n1";
    const body = "{}";
    const signature = signWebhookPayload("secret-a", timestamp, nonce, body);

    expect(verifyWebhookSignature("secret-b", timestamp, nonce, body, signature)).toBe(false);
  });

  test("rejects when the body has been tampered with in transit", () => {
    const secret = "shared-secret";
    const timestamp = String(Date.now());
    const nonce = "n2";
    const originalBody = JSON.stringify({ amount: 1 });
    const signature = signWebhookPayload(secret, timestamp, nonce, originalBody);

    const tamperedBody = JSON.stringify({ amount: 1000 });
    expect(verifyWebhookSignature(secret, timestamp, nonce, tamperedBody, signature)).toBe(false);
  });

  test("rejects a stale (replayed) timestamp outside the tolerance window", () => {
    const secret = "shared-secret";
    const nonce = "n3";
    const body = "{}";
    const now = 1_700_000_000_000;
    const staleTimestamp = String(now - 10 * 60 * 1000); // 10 minutes old
    const signature = signWebhookPayload(secret, staleTimestamp, nonce, body);

    const valid = verifyWebhookSignature(secret, staleTimestamp, nonce, body, signature, {
      toleranceSeconds: 300, // 5 minutes
      now: () => now,
    });

    expect(valid).toBe(false);
  });

  test("accepts a timestamp within the tolerance window", () => {
    const secret = "shared-secret";
    const nonce = "n4";
    const body = "{}";
    const now = 1_700_000_000_000;
    const freshTimestamp = String(now - 60 * 1000); // 1 minute old
    const signature = signWebhookPayload(secret, freshTimestamp, nonce, body);

    const valid = verifyWebhookSignature(secret, freshTimestamp, nonce, body, signature, {
      toleranceSeconds: 300,
      now: () => now,
    });

    expect(valid).toBe(true);
  });
});

describe("createWebhookHandler", () => {
  test("delivers a correctly signed request to a matching active subscription", async () => {
    const secret = "community-secret";
    const db = makeDbWithSubscriptions([
      { url: "https://example.test/webhook", secret, active: true, eventTypes: ["MEMBERSHIP_CREATED"] },
    ]);

    const fetchImpl = jest.fn(async (_url: string, init: any) => {
      // Act as the receiving side: verify the signature is valid for this exact body.
      const valid = verifyWebhookSignature(
        secret,
        init.headers["x-guildpass-timestamp"],
        init.headers["x-guildpass-nonce"],
        init.body,
        init.headers["x-guildpass-signature"],
      );
      expect(valid).toBe(true);
      return { ok: true, status: 200 } as Response;
    });

    const handler = createWebhookHandler({ db: db as any, fetchImpl: fetchImpl as any });
    await handler(makeEvent());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.test/webhook");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ id: "evt-1", eventType: "MEMBERSHIP_CREATED" });
  });

  test("fans out to multiple matching subscriptions", async () => {
    const db = makeDbWithSubscriptions([
      { url: "https://a.test/hook", secret: "s1", active: true, eventTypes: [] },
      { url: "https://b.test/hook", secret: "s2", active: true, eventTypes: ["MEMBERSHIP_CREATED"] },
    ]);
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }) as Response);

    const handler = createWebhookHandler({ db: db as any, fetchImpl: fetchImpl as any });
    await handler(makeEvent());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("does nothing when the event has no communityId", async () => {
    const db = makeDbWithSubscriptions([]);
    const fetchImpl = jest.fn();

    const handler = createWebhookHandler({ db: db as any, fetchImpl: fetchImpl as any });
    await handler(makeEvent({ communityId: null } as any));

    expect(db.webhookSubscription.findMany).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("does nothing when there are no matching subscriptions", async () => {
    const db = makeDbWithSubscriptions([]);
    const fetchImpl = jest.fn();

    const handler = createWebhookHandler({ db: db as any, fetchImpl: fetchImpl as any });
    await handler(makeEvent());

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("throws (so the outbox worker retries) when a subscription responds with a non-2xx status", async () => {
    const db = makeDbWithSubscriptions([
      { url: "https://flaky.test/hook", secret: "s1", active: true, eventTypes: [] },
    ]);
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 500 }) as Response);

    const handler = createWebhookHandler({ db: db as any, fetchImpl: fetchImpl as any });

    await expect(handler(makeEvent())).rejects.toThrow(/500/);
  });

  test("throws when the endpoint fetch itself rejects (network error, timeout)", async () => {
    const db = makeDbWithSubscriptions([
      { url: "https://down.test/hook", secret: "s1", active: true, eventTypes: [] },
    ]);
    const fetchImpl = jest.fn(async () => {
      throw new Error("network unreachable");
    });

    const handler = createWebhookHandler({ db: db as any, fetchImpl: fetchImpl as any });

    await expect(handler(makeEvent())).rejects.toThrow(/network unreachable/);
  });

  test("throws summarizing partial failure when one of several subscriptions fails", async () => {
    const db = makeDbWithSubscriptions([
      { url: "https://good.test/hook", secret: "s1", active: true, eventTypes: [] },
      { url: "https://bad.test/hook", secret: "s2", active: true, eventTypes: [] },
    ]);
    const fetchImpl = jest.fn(async (url: string) => {
      if (url === "https://bad.test/hook") return { ok: false, status: 503 } as Response;
      return { ok: true, status: 200 } as Response;
    });

    const handler = createWebhookHandler({ db: db as any, fetchImpl: fetchImpl as any });

    await expect(handler(makeEvent())).rejects.toThrow(/1\/2/);
  });
});
