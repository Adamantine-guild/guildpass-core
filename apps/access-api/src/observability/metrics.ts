/**
 * metrics.ts
 *
 * Lightweight Prometheus metrics via prom-client.
 *
 * Exposes:
 *   - http_request_duration_seconds  histogram  (method, route, status_code)
 *   - http_requests_total            counter    (method, route, status_code)
 *   - access_policy_decisions_total  counter    (outcome, rule_id, reason_code)
 *   - db_query_duration_seconds      histogram  (operation, model)
 *
 * Usage:
 *   import { registry, metrics } from './metrics';
 *   metrics.httpRequestDuration.observe({ method, route, status_code }, seconds);
 *
 * Dependencies: prom-client
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

// --------------------------------------------------------------------------
// Registry
// --------------------------------------------------------------------------

/**
 * Isolated registry (avoids polluting the default global registry which can
 * cause "metric already registered" errors in tests).
 */
export const registry = new Registry();

// Collect Node.js default metrics (memory, CPU, event loop lag, etc.)
collectDefaultMetrics({ register: registry });

// --------------------------------------------------------------------------
// HTTP Metrics
// --------------------------------------------------------------------------

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

// --------------------------------------------------------------------------
// Access Policy Decision Metrics
// --------------------------------------------------------------------------

/**
 * Tracks every allow/deny decision emitted by the policy engine.
 *
 * Labels:
 *   outcome     – "ALLOW" | "DENY"
 *   rule_id     – the policy rule id (e.g. "MEMBERS_ONLY")
 *   reason_code – the first reason code from AccessDecision.reasons
 */
const accessDecisionsTotal = new Counter({
  name: 'access_policy_decisions_total',
  help: 'Total access policy decisions by outcome, rule, and reason',
  labelNames: ['outcome', 'rule_id', 'reason_code'] as const,
  registers: [registry],
});

// --------------------------------------------------------------------------
// Database Metrics
// --------------------------------------------------------------------------

/**
 * Tracks Prisma query latency per model and operation type.
 *
 * Labels:
 *   operation – "findUnique" | "findFirst" | "findMany" | …
 *   model     – "Wallet" | "Member" | "AccessPolicy" | …
 */
const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of Prisma database queries in seconds',
  labelNames: ['operation', 'model'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

// --------------------------------------------------------------------------
// Outbox Metrics
// --------------------------------------------------------------------------

/**
 * Tracks outbox event creation per event type.
 */
const outboxEventsCreatedTotal = new Counter({
  name: 'outbox_events_created_total',
  help: 'Total number of outbox events created by event type',
  labelNames: ['event_type'] as const,
  registers: [registry],
});

/**
 * Tracks outbox event delivery outcomes.
 */
const outboxEventsDeliveredTotal = new Counter({
  name: 'outbox_events_delivered_total',
  help: 'Total number of outbox events delivered',
  labelNames: ['event_type'] as const,
  registers: [registry],
});

const outboxEventsFailedTotal = new Counter({
  name: 'outbox_events_failed_total',
  help: 'Total number of outbox events permanently failed',
  labelNames: ['event_type'] as const,
  registers: [registry],
});

/**
 * Backlog depth: current count of pending events that are due for processing.
 * A rising backlog indicates the worker(s) cannot keep up with the production
 * rate and that more worker instances (or a larger batch size) may be needed.
 */
const outboxBacklogDepth = new Gauge({
  name: 'outbox_backlog_depth',
  help: 'Number of pending outbox events currently due for processing',
  registers: [registry],
});

/**
 * Tracks the current adaptive batch size of each worker shard so operators
 * can observe backpressure-driven reductions.
 */
const outboxWorkerBatchSize = new Gauge({
  name: 'outbox_worker_batch_size',
  help: 'Current adaptive batch size per outbox worker shard',
  labelNames: ['shard'] as const,
  registers: [registry],
});

// --------------------------------------------------------------------------
// Exported handle
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Audit Chain Metrics
// --------------------------------------------------------------------------

const auditChainWriteDuration = new Histogram({
  name: 'audit_chain_write_duration_seconds',
  help: 'Duration of audit chain hash computation and write in seconds',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [registry],
});

/**
 * Tracks the indexing lag in blocks per chain.
 */
const indexerLag = new Gauge({
  name: 'guildpass_indexer_lag_blocks',
  help: 'Difference between current chain tip and last processed block',
  labelNames: ['chain_id'] as const,
  registers: [registry],
});

export const metrics = {
  httpRequestDuration,
  httpRequestsTotal,
  accessDecisionsTotal,
  dbQueryDuration,
  outboxEventsCreatedTotal,
  outboxEventsDeliveredTotal,
  outboxEventsFailedTotal,
  outboxBacklogDepth,
  outboxWorkerBatchSize,
  auditChainWriteDuration,
  indexerLag,
};
