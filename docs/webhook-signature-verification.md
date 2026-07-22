# Webhook signature verification

GuildPass outbox webhooks should be signed with an HMAC-SHA256 over the raw request body.

## Sender-side format

The sender computes:

- signature = HMAC-SHA256(secret, `${timestamp}.${body}`)
- headers:
  - `x-guildpass-signature`: hex-encoded signature
  - `x-guildpass-timestamp`: Unix milliseconds string

The timestamp is intended to be checked for freshness on the receiver side. Receivers should also keep a cache of seen nonces or request IDs for a short window to reject replayed deliveries.

## Receiver-side verification recipe

A receiving service should:

1. Read the raw request body as bytes.
2. Recompute the signature using the shared secret and the same timestamp/body.
3. Compare the recomputed signature to the incoming `x-guildpass-signature` in constant time.
4. Reject the request if the timestamp is older than the configured tolerance window.
5. Reject the request if the nonce/timestamp pair has already been processed.

Example verification in Node.js:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyGuildPassWebhook(secret: string, timestamp: string, body: Buffer, signature: string) {
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body.toString("utf8")}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  if (!timingSafeEqual(expectedBuf, actualBuf)) return false;

  const now = Date.now();
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > 5 * 60 * 1000) return false;

  return true;
}
```

## Replay protection

A receiver should persist a short-lived cache of seen `(timestamp, signature)` or `(timestamp, body hash)` values and reject duplicates during the allowed freshness window. This protects against replays of the same payload while the timestamp remains valid.
