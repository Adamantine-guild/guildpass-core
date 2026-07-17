/**
 * webhookHandler.ts
 *
 * Production-ready OutboxEventHandler that delivers outbox events as
 * HMAC-signed HTTP webhooks to a community's registered subscriptions
 * (WebhookSubscription), per the pluggable-handler pattern documented in
 * README.md's Integration Event Outbox section.
 *
 * Signature scheme (see README.md "Webhook Signature Verification" for the
 * consumer-facing version of this doc):
 *   signature = HMAC_SHA256(secret, `${timestamp}.${nonce}.${body}`)
 * sent as hex in the `X-GuildPass-Signature` header, alongside
 * `X-GuildPass-Timestamp` (unix ms) and `X-GuildPass-Nonce` (random UUID).
 * The timestamp + nonce are anti-replay fields: a consumer should reject
 * requests with a stale timestamp and should remember nonces it has already
 * processed (see verifyWebhookSignature below).
 *
 * Delivery semantics:
 *   - One outbox event may fan out to multiple subscriptions (per-community,
 *     filtered by eventTypes). If ANY subscription delivery fails, this
 *     handler throws so the outbox worker's existing retry/backoff applies
 *     to the whole event — subsequent attempts re-deliver to subscriptions
 *     that already succeeded too, since webhook consumers are expected to
 *     be idempotent on (eventId, nonce).
 *   - Requests are aborted after `timeoutMs` (default 5s) so a single slow
 *     or hung endpoint can't stall the outbox worker's batch.
 *   - No subscriptions for the event's community/type is not an error —
 *     the event is simply marked delivered with nothing to do.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../services/prisma";
import type { OutboxEventHandler } from "../workers/outboxWorker";

type WebhookSubscriptionClient = {
  findMany: (args?: any) => Promise<any[]>;
};

type PrismaLikeClient = {
  webhookSubscription: WebhookSubscriptionClient;
};

export interface WebhookHandlerConfig {
  /** Injectable Prisma client, primarily for tests. Defaults to getPrisma(). */
  db?: PrismaLikeClient | PrismaClient;
  /** Injectable fetch implementation, primarily for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Abort a single delivery attempt after this many milliseconds. Default 5000. */
  timeoutMs?: number;
}

/**
 * Sign a webhook payload. Exposed so `createWebhookHandler` and tests (and
 * a documentation example for consumers) use the exact same derivation.
 */
export function signWebhookPayload(
  secret: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest("hex");
}

export interface VerifyWebhookOptions {
  /** How old a timestamp may be before it's rejected as a replay. Default 300s. */
  toleranceSeconds?: number;
  /** Clock to use for the tolerance check, primarily for tests. */
  now?: () => number;
}

/**
 * Reference implementation of the verification a webhook consumer should
 * perform: recompute the HMAC and compare it in constant time, then reject
 * stale timestamps. Consumers must ALSO track nonces they've already seen
 * (e.g. in Redis with a TTL matching `toleranceSeconds`) and reject
 * duplicates — this function only proves the signature is authentic and
 * fresh, not that the nonce is unused, since that requires consumer-side
 * storage this library has no access to.
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  body: string,
  signature: string,
  options: VerifyWebhookOptions = {},
): boolean {
  const expected = signWebhookPayload(secret, timestamp, nonce, body);

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  if (!timingSafeEqual(expectedBuf, actualBuf)) return false;

  const toleranceMs = (options.toleranceSeconds ?? 300) * 1000;
  const now = (options.now ?? Date.now)();
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > toleranceMs) return false;

  return true;
}

interface DeliveryFailure {
  url: string;
  reason: string;
}

async function deliverToSubscription(
  subscription: { url: string; secret: string },
  bodyJson: string,
  timestamp: string,
  nonce: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  const signature = signWebhookPayload(subscription.secret, timestamp, nonce, bodyJson);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(subscription.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-guildpass-signature": signature,
        "x-guildpass-timestamp": timestamp,
        "x-guildpass-nonce": nonce,
      },
      body: bodyJson,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`endpoint responded with HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create an OutboxEventHandler that delivers events as HMAC-signed webhooks
 * to every active WebhookSubscription registered for the event's community
 * and event type.
 */
export function createWebhookHandler(config: WebhookHandlerConfig = {}): OutboxEventHandler {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 5000;

  return async (event) => {
    if (!event.communityId) return;

    const db = (config.db ?? getPrisma()) as PrismaLikeClient;
    const subscriptions = await db.webhookSubscription.findMany({
      where: {
        communityId: event.communityId,
        active: true,
        OR: [{ eventTypes: { isEmpty: true } }, { eventTypes: { has: event.eventType } }],
      },
    });

    if (subscriptions.length === 0) return;

    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const bodyJson = JSON.stringify({
      id: event.id,
      eventType: event.eventType,
      entityId: event.entityId,
      entityType: event.entityType,
      communityId: event.communityId,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    });

    const results = await Promise.allSettled(
      subscriptions.map((subscription) =>
        deliverToSubscription(subscription, bodyJson, timestamp, nonce, fetchImpl, timeoutMs),
      ),
    );

    const failures: DeliveryFailure[] = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        failures.push({
          url: subscriptions[index].url,
          reason: result.reason?.message ?? String(result.reason),
        });
      }
    });

    if (failures.length > 0) {
      const summary = failures.map((f) => `${f.url} (${f.reason})`).join("; ");
      throw new Error(
        `Webhook delivery failed for ${failures.length}/${subscriptions.length} subscription(s): ${summary}`,
      );
    }
  };
}
