
## Integration Event Outbox

The outbox worker (`src/workers/outboxWorker.ts`) polls the `OutboxEvent` table and delivers pending events to a pluggable handler (webhooks, message brokers, etc.). It is safe to run more than one instance of this worker against the same database — no additional infrastructure (Redis, etc.) is required.

**How the locking works:**
- Each poll claims a batch with a single `SELECT ... FOR UPDATE SKIP LOCKED` statement (`claimPendingOutboxEvents` in `src/services/outboxService.ts`), so two instances polling at the same moment never claim the same row — a locked row is skipped, not blocked on.
- The claiming statement stamps `claimedAt` / `claimedBy` / `claimExpiresAt` on the rows it locks, in the same statement that locks them. There is no separate "claim, then commit" step.
- Delivery guarantee: **at-least-once, not exactly-once.** A handler that isn't idempotent on its own must tolerate redelivery.

**Crash recovery:**
- If a worker dies mid-batch (before calling `markOutboxDelivered`/`markOutboxFailed`), its claimed rows stay `status: 'pending'` with a `claimExpiresAt` that will elapse. Once it does, any worker's next poll reclaims them — there is no separate reaper process; the claim query's own `WHERE` clause (`claimExpiresAt IS NULL OR claimExpiresAt < now()`) is what makes an expired lease claimable again.
- The lease duration is `OUTBOX_WORKER_CLAIM_LEASE_MS` (default 60000ms / 1 minute). Set it comfortably above your handler's worst-case latency — too short and a live worker's rows can be claimed out from under it; too long and a genuinely crashed worker's rows sit unclaimed for longer.

**Ordering caveat:** a single worker with no concurrent competitor still delivers events in strict `createdAt` order, same as before this change. **Under concurrency, that ordering guarantee no longer holds across workers** — `SKIP LOCKED` lets two instances grab non-adjacent rows in the same instant, so events can be delivered out of creation order when more than one instance is running. If your handler depends on strict ordering, run a single instance.

**Running more than one instance:** just start additional processes pointed at the same `DATABASE_URL` — each `createOutboxWorker()` call generates its own `workerId` (a UUID) unless you pass one explicitly (or set `OUTBOX_WORKER_ID`), so instances never collide on identity. Delivery and failure counters are labeled with that `worker_id` for multi-instance observability.

**Why not a Redis leader lock?** Redis is already provisioned for other features, but a single-leader `SET NX PX` lock would serialize the entire outbox drain through one instance and make outbox correctness depend on Redis availability. Per-row `SKIP LOCKED` + claim leases keep coordination inside Postgres (the same store as the outbox), allow concurrent workers to drain disjoint batches, and still fail over when a lease expires after a crash. Prefer a single instance only if your handler requires strict global `createdAt` ordering.

**New config:**
- `OUTBOX_WORKER_CLAIM_LEASE_MS` (optional, default `60000`) — see crash recovery above.
- `OUTBOX_WORKER_ID` (optional) — stable claim / metrics identity; defaults to a random UUID per process start.

**Signed webhook delivery:**
- For production webhook delivery, use `createWebhookHandler` from `src/handlers/webhookHandler.ts` to fan out HMAC-signed webhooks to all active `WebhookSubscription` rows per community. Each request carries `x-guildpass-signature`, `x-guildpass-timestamp`, and `x-guildpass-nonce` headers with anti-replay protection.
- Receiver verification guidance is documented in [docs/webhook-signature-verification.md](../../docs/webhook-signature-verification.md).

## Audit Logging & Retention

This service records audit events (access checks and membership changes) in the AuditEvent table.

Retention guidance:
- Audit events can grow quickly. We recommend a retention policy:
  - Keep detailed event records (Json before/after) for 90 days.
  - Archive older events to a cheaper storage (e.g., S3) every 30-90 days.
  - Delete archived records from the DB after successful backup.
- Implement a daily job (cron) to:
  - Export events older than N days to archive storage.
  - Delete exported rows from the database.
- Consider adding DB partitioning by createdAt or communityId for high-volume deployments.
- Ensure proper access controls on archived audit data and set up secure, immutable storage where necessary.

## Observability

The `access-api` exposes a Prometheus metrics endpoint to monitor application health and usage.

- **Endpoint:** `GET /metrics`
- **Authentication:** Excluded from versioned auth. If `METRICS_TOKEN` is set in the environment, it requires a `Bearer <token>` header. Otherwise, it is unauthenticated.
- **Rate Limiting:** Excluded from global rate limiting.

### Available Metrics
- `outbox_events_created_total` — Total number of outbox events created.
- `outbox_events_delivered_total` — Total number of outbox events successfully delivered by the worker.
- `outbox_events_failed_total` — Total number of outbox events that permanently failed (exhausted retries).
- `access_decisions_total{decision="allowed"|"denied"}` — Total access policy decisions broken down by the final allowed or denied outcome.

