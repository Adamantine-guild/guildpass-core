# Contribution Score Normalisation

`@guildpass/contribution-normalisation` converts heterogeneous weighted
contribution metrics into a single bounded score. It is a standalone
mathematical primitive with no dependency on contribution persistence, badges,
rewards or any HTTP, Prisma or Redis layer.

Communities may eventually combine metrics such as merged commits, forum
participation and completed tasks. Those raw metrics operate on incompatible
scales, so they cannot be summed directly. This package defines how each metric
is projected onto one common scale and how the projections are combined.

## Score scale

All normalised values and the final score are expressed in **basis points**,
from `0` to `10000`, where `10000` bps means 100.00%. The bound is exported as
`SCORE_SCALE_BPS`.

## Metric model

Each metric declares the range over which it earns credit:

```ts
interface ContributionMetric {
  key: string;      // unique within a single call
  value: bigint;    // raw measurement
  minimum: bigint;  // value scoring 0 bps
  target: bigint;   // value scoring 10000 bps
  weightBps: number; // share of the final score, 0 to 10000
}
```

`minimum`, `target` and `value` must all be non-negative, and `target` must be
greater than or equal to `minimum`. Callers scoring a signed quantity, such as a
net figure that can fall below zero, must offset it into a non-negative range
before normalising.

## Normalisation

A metric with a non-empty range normalises to:

```text
normalisedBps = ((value - minimum) * 10000) / (target - minimum)
```

The division is an exact `bigint` division and therefore floors. A value falling
between two basis points always resolves downwards, so the same input never
produces two different scores.

### Clamping rules

Every metric reports which rule produced its value, through the `clamping`
field:

| Condition | `normalisedBps` | `clamping` |
| --------- | --------------- | ---------- |
| `minimum < value < target` | proportional | `in-range` |
| `value == minimum` | `0` | `in-range` |
| `value == target` | `10000` | `in-range` |
| `value < minimum` | `0` | `below-minimum` |
| `value > target` | `10000` | `above-target` |
| `minimum == target` and `value >= target` | `10000` | `zero-range-met` |
| `minimum == target` and `value < target` | `0` | `zero-range-below` |

Exceeding the target earns no credit beyond the target. The scale is bounded, so
one outsized metric cannot inflate a score past `10000` bps or compensate for a
metric that was never met.

A zero-range metric, where `minimum` equals `target`, is a defined case rather
than a division by zero. It behaves as a step function: reaching the target
scores the full scale, anything below scores nothing. This is the natural
reading of a pass/fail requirement expressed through the same interface.

## Weighted combination

Configured weights must total exactly `10000` bps. A partial total is rejected
rather than rescaled, because silently rescaling would make a configuration
error look like a low score.

Weighted contributions are accumulated exactly and divided once, at the end:

```text
scoreBps = (Σ normalisedBps_i * weightBps_i) / 10000
```

Flooring once over the exact sum, rather than once per metric, keeps the
truncation error below one basis point in total instead of letting it grow with
the number of metrics.

The result is bounded by construction: each `normalisedBps` is at most `10000`,
so the accumulator is at most `10000 * Σ weightBps_i = 10000 * 10000`, and the
final division yields at most `10000`.

## Determinism

- Every comparison, multiplication and division is `bigint` arithmetic. No
  threshold is computed in floating point.
- Normalised values, weights and the final score are returned as `number`
  because they are bounded by `10000`, where the conversion from `bigint` is
  exact. Unbounded quantities — the raw `value`, `minimum` and `target` — are
  returned as `bigint` and are never converted.
- Metric keys must be unique, and the returned breakdown is sorted by key. Two
  calls with the same metrics in a different array order produce deeply equal
  results, not merely equal scores.

## Usage

```ts
import { normaliseContributionScore } from '@guildpass/contribution-normalisation';

const result = normaliseContributionScore([
  { key: 'commits', value: 50n, minimum: 0n, target: 100n, weightBps: 6000 },
  { key: 'reviews', value: 25n, minimum: 0n, target: 100n, weightBps: 4000 },
]);

result.scoreBps;       // 4000
result.totalWeightBps; // 10000
result.metrics[0];
// {
//   key: 'commits',
//   value: 50n,
//   minimum: 0n,
//   target: 100n,
//   weightBps: 6000,
//   clamping: 'in-range',
//   normalisedBps: 5000,
//   weightedScoreBps: 3000,
// }
```

Every metric returns its inputs alongside its intermediate results, so a score
can be audited without re-running the engine. `weightedScoreBps` is floored per
metric for readability; the final score floors once over the exact sum, so these
per-metric figures may total slightly below `scoreBps`. The exact final score is
always reproducible from `normalisedBps` and `weightBps` using the combination
formula above.

## Failure codes

Invalid configuration is rejected before any scoring runs, by throwing a
`ValidationError` carrying a `code`:

- `EMPTY_METRICS`
- `INVALID_KEY`
- `DUPLICATE_KEY`
- `INVALID_VALUE`
- `INVALID_RANGE`
- `NEGATIVE_VALUE`
- `NEGATIVE_RANGE_BOUND`
- `INVALID_WEIGHT`
- `INVALID_TOTAL_WEIGHT`

## Scope

This package computes a score and returns it. It does not persist contributions,
track them over time, decide how metrics are collected, or award badges, roles
or rewards. Those belong to the contribution and reward engines, which may
consume this primitive.
