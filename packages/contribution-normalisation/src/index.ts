/**
 * Deterministic contribution score normalisation.
 *
 * Converts heterogeneous weighted contribution metrics, which may operate on
 * incompatible raw scales, into a single bounded score expressed in basis
 * points. Every threshold comparison and every division is performed with
 * `bigint` arithmetic, so results are exactly reproducible and independent of
 * floating-point behaviour.
 *
 * The engine is a pure scoring primitive: it performs no persistence, emits no
 * events and has no dependency on contribution, reward or badge systems.
 */

/** Upper bound of the normalised scale: 10000 basis points equals 100.00%. */
export const SCORE_SCALE_BPS = 10000;

const SCORE_SCALE = BigInt(SCORE_SCALE_BPS);

/**
 * Which clamping rule produced a metric's normalised value.
 *
 * - `in-range` — the raw value sat between `minimum` and `target` inclusive.
 * - `below-minimum` — the raw value was under `minimum` and scored 0 bps.
 * - `above-target` — the raw value exceeded `target` and scored 10000 bps.
 * - `zero-range-below` — `minimum` equalled `target` and the value was under
 *   it, scoring 0 bps.
 * - `zero-range-met` — `minimum` equalled `target` and the value reached it,
 *   scoring 10000 bps.
 */
export type MetricClamping =
  | 'in-range'
  | 'below-minimum'
  | 'above-target'
  | 'zero-range-below'
  | 'zero-range-met';

/** A single raw contribution metric and its configured scoring range. */
export interface ContributionMetric {
  /** Stable identifier, unique within a single call. */
  key: string;
  /** Raw measurement. Must not be negative. */
  value: bigint;
  /** Value scoring 0 bps. Must not be negative. */
  minimum: bigint;
  /** Value scoring 10000 bps. Must be greater than or equal to `minimum`. */
  target: bigint;
  /** Share of the final score, in basis points. Integer between 0 and 10000. */
  weightBps: number;
}

/** Per-metric intermediate results, returned for explainability. */
export interface MetricBreakdown {
  key: string;
  value: bigint;
  minimum: bigint;
  target: bigint;
  weightBps: number;
  /** Clamping rule that produced `normalisedBps`. */
  clamping: MetricClamping;
  /** Normalised position within the range, from 0 to 10000 bps. */
  normalisedBps: number;
  /**
   * This metric's weighted contribution, floored independently. Informational
   * only: the final score floors once over the exact sum, so these figures may
   * total slightly less than `scoreBps`.
   */
  weightedScoreBps: number;
}

/** Result of a normalisation run. */
export interface ContributionScoreResult {
  /** Final combined score, from 0 to 10000 bps. */
  scoreBps: number;
  /** Sum of the configured weights. Always 10000 for a successful run. */
  totalWeightBps: number;
  /** Per-metric breakdown, ordered by `key` so results are order-independent. */
  metrics: MetricBreakdown[];
}

/** Raised when metric or weight configuration is rejected before scoring. */
export class ValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function assertBigInt(
  candidate: unknown,
  code: string,
  label: string,
  key: string
): asserts candidate is bigint {
  if (typeof candidate !== 'bigint') {
    throw new ValidationError(code, `${label} for metric ${key} must be a bigint`);
  }
}

function validateMetric(metric: ContributionMetric, seenKeys: Set<string>): void {
  if (typeof metric.key !== 'string' || metric.key.length === 0) {
    throw new ValidationError('INVALID_KEY', 'Metric key must be a non-empty string');
  }

  if (seenKeys.has(metric.key)) {
    throw new ValidationError('DUPLICATE_KEY', `Duplicate metric key: ${metric.key}`);
  }
  seenKeys.add(metric.key);

  assertBigInt(metric.value, 'INVALID_VALUE', 'Value', metric.key);
  assertBigInt(metric.minimum, 'INVALID_RANGE', 'Minimum', metric.key);
  assertBigInt(metric.target, 'INVALID_RANGE', 'Target', metric.key);

  if (metric.value < 0n) {
    throw new ValidationError(
      'NEGATIVE_VALUE',
      `Negative value for metric ${metric.key}`
    );
  }

  if (metric.minimum < 0n || metric.target < 0n) {
    throw new ValidationError(
      'NEGATIVE_RANGE_BOUND',
      `Negative range bound for metric ${metric.key}`
    );
  }

  if (metric.target < metric.minimum) {
    throw new ValidationError(
      'INVALID_RANGE',
      `Target is below minimum for metric ${metric.key}`
    );
  }

  if (
    typeof metric.weightBps !== 'number' ||
    !Number.isInteger(metric.weightBps) ||
    metric.weightBps < 0 ||
    metric.weightBps > SCORE_SCALE_BPS
  ) {
    throw new ValidationError(
      'INVALID_WEIGHT',
      `Weight for metric ${metric.key} must be an integer between 0 and ${SCORE_SCALE_BPS} basis points`
    );
  }
}

/**
 * Normalises one metric into the 0 to 10000 bps scale.
 *
 * Uses a single exact `bigint` division, floored, so a value sitting between
 * two basis points always resolves downwards.
 */
function normaliseMetric(metric: ContributionMetric): {
  clamping: MetricClamping;
  normalised: bigint;
} {
  const range = metric.target - metric.minimum;

  if (range === 0n) {
    return metric.value >= metric.target
      ? { clamping: 'zero-range-met', normalised: SCORE_SCALE }
      : { clamping: 'zero-range-below', normalised: 0n };
  }

  if (metric.value < metric.minimum) {
    return { clamping: 'below-minimum', normalised: 0n };
  }

  if (metric.value > metric.target) {
    return { clamping: 'above-target', normalised: SCORE_SCALE };
  }

  return {
    clamping: 'in-range',
    normalised: ((metric.value - metric.minimum) * SCORE_SCALE) / range,
  };
}

/**
 * Combines weighted contribution metrics into a single bounded score.
 *
 * Each metric is normalised into the 0 to 10000 bps scale, multiplied by its
 * weight, and accumulated exactly. The accumulator is divided by the scale once
 * at the end, so no intermediate rounding is carried between metrics. Because
 * the configured weights must total exactly 10000 bps, the result is always
 * within 0 to 10000 bps.
 *
 * Metric order does not affect the result: keys must be unique and the returned
 * breakdown is sorted by key.
 *
 * @throws {ValidationError} If any metric or the total weight is invalid.
 */
export function normaliseContributionScore(
  metrics: readonly ContributionMetric[]
): ContributionScoreResult {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    throw new ValidationError('EMPTY_METRICS', 'At least one metric is required');
  }

  const seenKeys = new Set<string>();
  const breakdown: MetricBreakdown[] = [];
  let totalWeightBps = 0;
  let weightedTotal = 0n;

  for (const metric of metrics) {
    validateMetric(metric, seenKeys);

    const { clamping, normalised } = normaliseMetric(metric);
    const weighted = normalised * BigInt(metric.weightBps);

    totalWeightBps += metric.weightBps;
    weightedTotal += weighted;

    breakdown.push({
      key: metric.key,
      value: metric.value,
      minimum: metric.minimum,
      target: metric.target,
      weightBps: metric.weightBps,
      clamping,
      normalisedBps: Number(normalised),
      weightedScoreBps: Number(weighted / SCORE_SCALE),
    });
  }

  if (totalWeightBps !== SCORE_SCALE_BPS) {
    throw new ValidationError(
      'INVALID_TOTAL_WEIGHT',
      `Configured weights must total ${SCORE_SCALE_BPS} basis points, received ${totalWeightBps}`
    );
  }

  breakdown.sort((a, b) => {
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });

  return {
    scoreBps: Number(weightedTotal / SCORE_SCALE),
    totalWeightBps,
    metrics: breakdown,
  };
}
