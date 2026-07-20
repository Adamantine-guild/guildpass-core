# Outbox Worker Horizontal Scalability

## Problem

The outbox worker processed events with a single polling loop at a fixed interval
(OUTBOX_WORKER_INTERVAL_MS, default 10 s) with a fixed batch size
(OUTBOX_WORKER_BATCH_SIZE, default 50).  At those defaults the worker can drain
at most 5 events/s sustained.  A community platform with high mutation volume
(many simultaneous access decisions, role changes, membership updates) can
produce a backlog that a single fixed-interval poller cannot drain in a timely
fashion.

## Design

### Partitioning via `FOR UPDATE SKIP LOCKED`

The core partitioning primitive is PostgreSQL's `SELECT ... FOR UPDATE SKIP
LOCKED`.  Each concurrent worker shard (or even separate process instances)
runs a query that:

1. Selects pending events (`status = 'pending' AND nextRetryAt <= NOW()`)
   ordered by creation time (oldest first).
2. Applies `LIMIT <batch_size>` so a single shard claims at most N events
   per poll cycle.
3. Applies `FOR UPDATE SKIP LOCKED` so rows locked by another transaction are
   silently skipped.

PostgreSQL guarantees that each row is locked by exactly one transaction at a
time.  `SKIP LOCKED` is non-blocking: if a row is already locked by another
worker the query simply omits it from the result set.  This lets N workers run
the same query concurrently without coordination and without duplicate delivery.

```
Shard 1: SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50  →  claims events 1–50
Shard 2: SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50  →  claims events 51–100
Shard 3: SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50  →  claims events 101–150
```

Once a shard marks an event as `delivered` (or `failed` after retry exhaustion)
the row's lock is released and that row no longer matches the `status =
'pending'` predicate in subsequent queries.

### Worker Shards

The `createOutboxWorker` factory accepts a `workerCount` option (default 1).
When started it launches that many independent `setInterval` loops ("shards").
Each shard:

- Has its own `AdaptiveBatch` tracker.
- Calls `claimPendingOutboxEventsWithLock` (the raw-SQL `FOR UPDATE SKIP
  LOCKED` query) on every tick.
- Processes claimed events sequentially within its batch (events within a shard
  remain ordered by `createdAt`).
- Reports its current adaptive batch size via the
  `outbox_worker_batch_size{shard="<id>"}` gauge.

#### Why hash-partitioning by `communityId` was NOT chosen

The issue description mentions hash-partitioning by `communityId` or
`eventType`.  We deliberately chose `FOR UPDATE SKIP LOCKED` over application-
level hash partitioning for three reasons:

1. **Simplicity** — No partition-map management, no rebalancing when new
   workers join or leave, no skew caused by a single hot community.
2. **Elasticity** — Workers can be added or removed at any time without
   reconfiguring partition assignments.  An extra process instance started by
   an auto-scaler will naturally claim its share of the backlog on its first
   poll cycle.
3. **Equal load distribution** — `SKIP LOCKED` with FIFS ordering (`ORDER BY
   createdAt ASC`) approximates fair consumption without manual partitioning.

The trade-off is that we must use raw SQL (`$queryRaw`) instead of Prisma's
`findMany`, which means unit tests need to mock at a slightly lower level.  In
practice the `processOutboxBatch` integration path is straightforward.

### Adaptive Batch Sizing

Each shard tracks the number of consecutive batch iterations where zero events
were successfully delivered.  When this counter reaches
`BACKPRESSURE_CONSECUTIVE_THRESHOLD` (3):

- The batch size is halved (floored, clamped to `minBatchSize`).
- An exponential backoff delay is added to the shard's `setInterval` period:
  1 s, 2 s, 4 s, … (doubling each consecutive zero-delivery cycle).

When deliveries succeed, the consecutive-failure counter resets and the batch
size ramps up by +5 per successful iteration until it reaches `maxBatchSize`.

This prevents a struggling downstream consumer (e.g. a webhook endpoint that
is timing out) from being overwhelmed by retries.

### Backlog Depth Metric

A shared timer (one per process, not one per shard) runs every 15 s and
reports `COUNT(*) WHERE status = 'pending' AND nextRetryAt <= NOW()` as the
`outbox_backlog_depth` gauge.  Operators can alert on a rising backlog
to trigger horizontal scale-out (increase `workerCount` or add process
instances).

## Limits

### Database connection ceiling

Each shard (and each process instance) holds at least one connection from the
Prisma connection pool during its poll cycle.  The total number of concurrent
workers across all instances must not exceed the pool size minus headroom for
API request handlers.  With Prisma's default pool of `connection_limit=10` and
the API using ~3 connections under load, maximum safe worker count is ~7.

For higher throughput, increase `DATABASE_URL`'s `connection_limit` parameter
or use PgBouncer (transaction mode) to multiplex connections.

### Single-DB write throughput

At very high volumes the `OutboxEvent` table's PK index and the `status` +
`nextRetryAt` index become the bottleneck.  The `FOR UPDATE SKIP LOCKED` query
performs an index scan on `(status, nextRetryAt)` and then locks qualifying
rows.  If the backlog is deep (millions of rows) the index scan itself may be
slow.  Periodic pruning of delivered events (7-day retention) keeps the table
and its indexes compact.

### No exactly-once guarantee

`FOR UPDATE SKIP LOCKED` prevents duplicate *claiming* of events, but it does
not prevent duplicate *delivery*: a shard could mark an event as delivered and
then crash before the `UPDATE` commits.  Downstream handlers should be
idempotent (use the event `id` or `correlationId` as a deduplication key).

## Configuration Reference

| Env var | Default | Description |
|---|---|---|
| `OUTBOX_WORKER_INTERVAL_MS` | `10000` | Poll interval per shard (ms) |
| `OUTBOX_WORKER_BATCH_SIZE` | `50` | Max events per shard per poll |
| `OUTBOX_WORKER_COUNT` | `1` | Number of concurrent shards |
| `OUTBOX_WORKER_MIN_BATCH_SIZE` | `5` | Min batch under backpressure |

## Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `outbox_events_created_total` | Counter | `event_type` | Events created |
| `outbox_events_delivered_total` | Counter | `event_type` | Events delivered |
| `outbox_events_failed_total` | Counter | `event_type` | Events permanently failed |
| `outbox_backlog_depth` | Gauge | — | Pending events due for processing |
| `outbox_worker_batch_size` | Gauge | `shard` | Current adaptive batch size |
