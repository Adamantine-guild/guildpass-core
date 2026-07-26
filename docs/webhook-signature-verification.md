# Webhook Signature Verification

GuildPass delivers outbox events as HMAC-signed HTTP webhooks to each
community's registered `WebhookSubscription`. Every request is signed with
the subscription's per-community secret and carries anti-replay fields that
consumers must validate.

---

## Sender-side format

The sender (GuildPass) computes the signature and attaches three headers:

```
signature = hex(HMAC-SHA256(secret, "${timestamp}.${nonce}.${body}"))
```

| Header | Description |
| ------ | ----------- |
| `x-guildpass-signature` | Hex-encoded HMAC-SHA256 signature |
| `x-guildpass-timestamp` | Unix epoch milliseconds when the request was signed |
| `x-guildpass-nonce` | Random UUID v4, unique per delivery attempt |

The **raw request body** (exactly the bytes received, before any parsing) is
the `body` input to the HMAC. If your framework parses JSON before your
middleware runs, you must capture the raw body buffer separately.

`webhookHandler.ts` (`signWebhookPayload` / `verifyWebhookSignature`) is the
canonical reference implementation of this scheme.

---

## Receiver-side verification recipe

A receiving service must perform **three** checks. Skipping any of them
creates a vulnerability:

### 1. Signature verification (constant-time)

Recompute the HMAC from your stored secret, the received timestamp, the
received nonce, and the raw request body bytes, then compare it to
`x-guildpass-signature` using a constant-time comparison. Never use `===`
or `==` on signatures or secrets — that leaks timing information.

### 2. Timestamp freshness check

Reject the request if `x-guildpass-timestamp` is older than your tolerance
window (5 minutes / 300 000 ms is recommended). This bounds how long a
captured request could be replayed. Make sure your server clock is
synchronised (e.g. via NTP).

### 3. Nonce deduplication (replay protection)

Reject the request if you have already processed `x-guildpass-nonce`. The
timestamp check alone does **not** prevent replay *within* the tolerance
window — an attacker who captures a valid request can re-send it for up to
5 minutes unless you track seen nonces.

**Recommended approach:** atomically check-and-set the nonce in a
datastore with a TTL matching your tolerance window. Redis is a common
choice:

```
SET x-guildpass-nonce:{nonce} 1 NX EX 300
```

If the `SET` returns `OK` the nonce is new — proceed. If it returns `nil`
the nonce has been seen before — reject with `409 Conflict`. After the TTL
expires the key is automatically cleaned up so your storage doesn't grow
unbounded.

An in-memory `Set` or `Map` with periodic pruning is also viable for
single-process receivers, but be aware that nonce state is lost on restart.

---

## Standalone verification example (Node.js, no dependencies)

This example uses only Node.js built-ins (`node:crypto`). It is
independent of the GuildPass codebase so integrators on other stacks can
use it as a reference for porting to their language of choice.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a GuildPass webhook request.
 *
 * @param secret       The shared secret from your WebhookSubscription.
 * @param timestamp    Value of the `x-guildpass-timestamp` header.
 * @param nonce        Value of the `x-guildpass-nonce` header.
 * @param rawBody      The raw request body bytes (before JSON parsing).
 * @param signature    Value of the `x-guildpass-signature` header.
 * @param toleranceMs  Maximum age of the timestamp in milliseconds. Default 5 min.
 * @param nonceStore   An async function (nonce: string) => Promise<boolean> that
 *                     atomically checks whether a nonce has been seen and marks it
 *                     as seen. Return `true` if the nonce is new, `false` if it's a
 *                     replay.
 * @returns `true` if the request is authentic, fresh, and not a replay.
 */
export async function verifyGuildPassWebhook(
  secret: string,
  timestamp: string,
  nonce: string,
  rawBody: Buffer,
  signature: string,
  toleranceMs: number = 5 * 60 * 1000,
  nonceStore: (nonce: string) => Promise<boolean>,
): Promise<boolean> {
  // 1. Signature check — constant-time comparison
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${nonce}.${rawBody.toString("utf8")}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  if (!timingSafeEqual(expectedBuf, actualBuf)) return false;

  // 2. Timestamp freshness check
  const now = Date.now();
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > toleranceMs) return false;

  // 3. Nonce deduplication — consumer-side storage
  if (!(await nonceStore(nonce))) return false;

  return true;
}
```

### Usage example with a Redis-backed nonce store

```ts
import { createClient } from "redis";

const redis = createClient();
await redis.connect();

const nonceStore = async (nonce: string): Promise<boolean> => {
  // SET NX EX is atomic: returns "OK" only if the key didn't exist
  // TTL of 300s matches the 5-minute tolerance window
  const result = await redis.set(
    `x-guildpass-nonce:${nonce}`,
    "1",
    { NX: true, EX: 300 },
  );
  return result === "OK";
};

// Inside your webhook route handler (e.g. Express):
app.post("/webhooks/guildpass", async (req, res) => {
  const secret = process.env.GUILDPASS_WEBHOOK_SECRET!;

  // You must capture the raw body before any JSON body-parser middleware.
  // With Express, use `express.raw({ type: "application/json" })` on this
  // route and access `req.body` (which will be a Buffer).
  const rawBody: Buffer = req.body;

  if (
    !(await verifyGuildPassWebhook(
      secret,
      req.headers["x-guildpass-timestamp"] as string,
      req.headers["x-guildpass-nonce"] as string,
      rawBody,
      req.headers["x-guildpass-signature"] as string,
      5 * 60 * 1000,
      nonceStore,
    ))
  ) {
    res.status(401).send("Invalid signature or replay");
    return;
  }

  // Signature is valid, timestamp is fresh, nonce is new — process the event
  const event = JSON.parse(rawBody.toString("utf8"));
  await handleGuildPassEvent(event);
  res.status(200).send("OK");
});
```

### Simplest possible nonce store (in-memory, single process)

If you run a single process and can tolerate lost nonce state on restart:

```ts
const seenNonces = new Set<string>();

// Periodically prune entries older than the tolerance window
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const entry of seenNonces) {
    const [, ts] = entry.split(":");
    if (Number(ts) < cutoff) seenNonces.delete(entry);
  }
}, 60_000);

// Embed the timestamp in the lookup key so pruning works on age.
// Pass a wrapper that captures the timestamp from the request:
const createNonceStore = (timestamp: string) => {
  return async (nonce: string): Promise<boolean> => {
    const key = `${nonce}:${timestamp}`;
    if (seenNonces.has(key)) return false;
    seenNonces.add(key);
    return true;
  };
};

// Usage in the route handler:
const nonceStore = createNonceStore(req.headers["x-guildpass-timestamp"] as string);
if (!(await verifyGuildPassWebhook(secret, ts, nonce, rawBody, sig, 300_000, nonceStore))) {
  res.status(401).send("Invalid signature or replay");
  return;
}
```

---

## Replay protection in depth

| Attack | Mitigation |
| ------ | ---------- |
| Replay an old request after the tolerance window | Timestamp check rejects it — the timestamp will be too old |
| Replay a captured request within the tolerance window | Nonce deduplication rejects it — the nonce has already been seen |
| Attacker crafts a signature with a stolen secret | Rotate the subscription secret immediately; all subsequent requests with the old secret will fail signature verification |
| Clock skew between sender and receiver | Use a tolerance window large enough for your clocks' maximum skew (5 min is generous for NTP-synced clocks). If your server isn't NTP-synced, increase the window accordingly — but note that a larger window also increases the replay surface. |

**Nonce storage requirements:**

- Nonces must be tracked for at least the duration of your timestamp tolerance window.
- The check-and-set operation must be **atomic** — if two requests with the same nonce arrive concurrently, exactly one must succeed.
- Storage should be pruned automatically (e.g. Redis TTL) or periodically so it doesn't grow unbounded.
- Nonce state does not need to survive a restart of your service, but losing it means replays within the tolerance window could succeed until the window closes.

---

## Reference

- **Canonical implementation:** `apps/access-api/src/handlers/webhookHandler.ts`
  (`signWebhookPayload`, `verifyWebhookSignature`, `createWebhookHandler`)
- **Tests:** `apps/access-api/src/handlers/webhookHandler.test.ts`
- **Outbox design:** `README.md` → Integration Event Outbox section
