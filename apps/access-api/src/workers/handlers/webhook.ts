import { createHmac, timingSafeEqual } from "node:crypto";
import type { OutboxEventHandler } from "../../workers/outboxWorker";

export interface WebhookOutboxHandlerOptions {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  options: { toleranceSeconds?: number; now?: () => number } = {},
): boolean {
  const expected = signWebhookPayload(secret, timestamp, body);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createWebhookOutboxHandler(
  options: WebhookOutboxHandlerOptions,
): OutboxEventHandler {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 2_000;

  return async (event) => {
    const timestamp = String(Date.now());
    const body = JSON.stringify({
      id: event.id,
      eventType: event.eventType,
      entityId: event.entityId,
      entityType: event.entityType,
      communityId: event.communityId,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    });
    const signature = signWebhookPayload(options.secret, timestamp, body);

    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-guildpass-signature": signature,
            "x-guildpass-timestamp": timestamp,
          },
          body,
          signal: controller.signal,
        });

        if (response.ok) {
          return;
        }

        if (attempt >= maxAttempts) {
          throw new Error(`endpoint responded with HTTP ${response.status}`);
        }
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw error;
        }
      } finally {
        clearTimeout(timer);
      }

      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await delay(delayMs);
    }
  };
}
