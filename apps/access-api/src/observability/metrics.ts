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

import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

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
// Exported handle
// --------------------------------------------------------------------------

export const metrics = {
  httpRequestDuration,
  httpRequestsTotal,
  accessDecisionsTotal,
  dbQueryDuration,
};
