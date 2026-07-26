import { createWebhookOutboxHandler, signWebhookPayload, verifyWebhookSignature } from "./webhook";

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

describe("signWebhookPayload / verifyWebhookSignature", () => {
  test("signs payloads with HMAC and a receiver can verify them", () => {
    const secret = "shared-secret";
    const timestamp = String(Date.now());
    const body = JSON.stringify({ hello: "world" });

    const signature = signWebhookPayload(secret, timestamp, body);
    const valid = verifyWebhookSignature(secret, timestamp, body, signature);

    expect(valid).toBe(true);
  });

  test("rejects tampered payloads", () => {
    const secret = "shared-secret";
    const timestamp = String(Date.now());
    const originalBody = JSON.stringify({ amount: 1 });
    const signature = signWebhookPayload(secret, timestamp, originalBody);

    const tamperedBody = JSON.stringify({ amount: 2 });
    const valid = verifyWebhookSignature(secret, timestamp, tamperedBody, signature);

    expect(valid).toBe(false);
  });
});

describe("createWebhookOutboxHandler", () => {
  test("sends signed headers and retries transient failures before succeeding", async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, [string, RequestInit?]>()
      .mockRejectedValueOnce(new Error("transient network error"))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const handler = createWebhookOutboxHandler({
      url: "https://example.test/webhook",
      secret: "shared-secret",
      fetchImpl: fetchImpl as typeof fetch,
      maxAttempts: 2,
      baseDelayMs: 0,
    });

    await expect(handler(makeEvent())).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init?.headers).toMatchObject({
      "x-guildpass-signature": expect.any(String),
      "x-guildpass-timestamp": expect.any(String),
    });
  });
});
