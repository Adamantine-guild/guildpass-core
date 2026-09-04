import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  normaliseContributionScore,
  SCORE_SCALE_BPS,
  ValidationError,
  ContributionMetric,
} from './index.js';

function expectValidationError(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ValidationError, 'expected a ValidationError');
    assert.strictEqual(error.code, code);
    return true;
  };
}

/** A single fully weighted metric, so the score equals its normalised value. */
function singleMetric(
  overrides: Partial<ContributionMetric> = {}
): ContributionMetric[] {
  return [
    {
      key: 'commits',
      value: 50n,
      minimum: 0n,
      target: 100n,
      weightBps: SCORE_SCALE_BPS,
      ...overrides,
    },
  ];
}

describe('normaliseContributionScore', () => {
  it('exposes the documented score scale', () => {
    assert.strictEqual(SCORE_SCALE_BPS, 10000);
  });

  describe('normalisation', () => {
    it('normalises a mid-range value to its exact proportion', () => {
      const result = normaliseContributionScore(singleMetric());

      assert.strictEqual(result.scoreBps, 5000);
      assert.strictEqual(result.totalWeightBps, 10000);
      assert.strictEqual(result.metrics[0]?.normalisedBps, 5000);
      assert.strictEqual(result.metrics[0]?.clamping, 'in-range');
    });

    it('is deterministic across repeated calls', () => {
      const first = normaliseContributionScore(singleMetric({ value: 37n }));
      const second = normaliseContributionScore(singleMetric({ value: 37n }));

      assert.deepStrictEqual(first, second);
    });

    it('floors a value that falls between two basis points', () => {
      // 1 / 3 of the range is 3333.33... bps, which must resolve downwards.
      const result = normaliseContributionScore(
        singleMetric({ value: 1n, minimum: 0n, target: 3n })
      );

      assert.strictEqual(result.metrics[0]?.normalisedBps, 3333);
      assert.strictEqual(result.scoreBps, 3333);
    });

    it('normalises against a non-zero minimum', () => {
      const result = normaliseContributionScore(
        singleMetric({ value: 75n, minimum: 50n, target: 150n })
      );

      assert.strictEqual(result.metrics[0]?.normalisedBps, 2500);
    });
  });

  describe('boundary values', () => {
    it('scores 0 bps when the value equals the minimum', () => {
      const result = normaliseContributionScore(singleMetric({ value: 0n }));

      assert.strictEqual(result.metrics[0]?.normalisedBps, 0);
      assert.strictEqual(result.metrics[0]?.clamping, 'in-range');
      assert.strictEqual(result.scoreBps, 0);
    });

    it('scores the full scale when the value equals the target', () => {
      const result = normaliseContributionScore(singleMetric({ value: 100n }));

      assert.strictEqual(result.metrics[0]?.normalisedBps, 10000);
      assert.strictEqual(result.metrics[0]?.clamping, 'in-range');
      assert.strictEqual(result.scoreBps, 10000);
    });

    it('scores one basis point below the target correctly', () => {
      const result = normaliseContributionScore(
        singleMetric({ value: 9999n, minimum: 0n, target: 10000n })
      );

      assert.strictEqual(result.metrics[0]?.normalisedBps, 9999);
    });
  });

  describe('clamping', () => {
    it('clamps a value below the minimum to 0 bps', () => {
      const result = normaliseContributionScore(
        singleMetric({ value: 10n, minimum: 50n, target: 100n })
      );

      assert.strictEqual(result.metrics[0]?.normalisedBps, 0);
      assert.strictEqual(result.metrics[0]?.clamping, 'below-minimum');
    });

    it('clamps a value above the target to the full scale', () => {
      const result = normaliseContributionScore(singleMetric({ value: 5000n }));

      assert.strictEqual(result.metrics[0]?.normalisedBps, 10000);
      assert.strictEqual(result.metrics[0]?.clamping, 'above-target');
    });

    it('treats a zero-range metric as met when the value reaches the target', () => {
      const result = normaliseContributionScore(
        singleMetric({ value: 7n, minimum: 7n, target: 7n })
      );

      assert.strictEqual(result.metrics[0]?.normalisedBps, 10000);
      assert.strictEqual(result.metrics[0]?.clamping, 'zero-range-met');
    });

    it('treats a zero-range metric as unmet when the value is below the target', () => {
      const result = normaliseContributionScore(
        singleMetric({ value: 6n, minimum: 7n, target: 7n })
      );

      assert.strictEqual(result.metrics[0]?.normalisedBps, 0);
      assert.strictEqual(result.metrics[0]?.clamping, 'zero-range-below');
    });

    it('treats a zero-range metric as met when the value exceeds the target', () => {
      const result = normaliseContributionScore(
        singleMetric({ value: 99n, minimum: 7n, target: 7n })
      );

      assert.strictEqual(result.metrics[0]?.normalisedBps, 10000);
      assert.strictEqual(result.metrics[0]?.clamping, 'zero-range-met');
    });
  });

  describe('weighted combination', () => {
    it('combines weighted metrics exactly', () => {
      const result = normaliseContributionScore([
        { key: 'commits', value: 50n, minimum: 0n, target: 100n, weightBps: 6000 },
        { key: 'reviews', value: 25n, minimum: 0n, target: 100n, weightBps: 4000 },
      ]);

      // 5000 bps at 60% plus 2500 bps at 40% is 3000 + 1000.
      assert.strictEqual(result.scoreBps, 4000);
      assert.strictEqual(result.metrics[0]?.weightedScoreBps, 3000);
      assert.strictEqual(result.metrics[1]?.weightedScoreBps, 1000);
    });

    it('floors the combined score once rather than per metric', () => {
      // Each metric normalises to 3333 bps and weighs 50%, so each weighted
      // contribution is 1666.5 bps. Flooring per metric would yield 3332.
      const result = normaliseContributionScore([
        { key: 'a', value: 1n, minimum: 0n, target: 3n, weightBps: 5000 },
        { key: 'b', value: 1n, minimum: 0n, target: 3n, weightBps: 5000 },
      ]);

      assert.strictEqual(result.scoreBps, 3333);
      assert.strictEqual(result.metrics[0]?.weightedScoreBps, 1666);
      assert.strictEqual(result.metrics[1]?.weightedScoreBps, 1666);
    });

    it('accepts a zero-weighted metric without affecting the score', () => {
      const result = normaliseContributionScore([
        { key: 'counted', value: 50n, minimum: 0n, target: 100n, weightBps: 10000 },
        { key: 'ignored', value: 100n, minimum: 0n, target: 100n, weightBps: 0 },
      ]);

      assert.strictEqual(result.scoreBps, 5000);
      assert.strictEqual(result.metrics[1]?.normalisedBps, 10000);
      assert.strictEqual(result.metrics[1]?.weightedScoreBps, 0);
    });

    it('keeps the score inside the documented range when every metric is maxed', () => {
      const result = normaliseContributionScore([
        { key: 'a', value: 999n, minimum: 0n, target: 10n, weightBps: 3333 },
        { key: 'b', value: 999n, minimum: 0n, target: 10n, weightBps: 3333 },
        { key: 'c', value: 999n, minimum: 0n, target: 10n, weightBps: 3334 },
      ]);

      assert.strictEqual(result.scoreBps, 10000);
    });

    it('keeps the score at zero when every metric is below its minimum', () => {
      const result = normaliseContributionScore([
        { key: 'a', value: 0n, minimum: 10n, target: 20n, weightBps: 5000 },
        { key: 'b', value: 1n, minimum: 10n, target: 20n, weightBps: 5000 },
      ]);

      assert.strictEqual(result.scoreBps, 0);
    });
  });

  describe('large values', () => {
    it('supports metrics far beyond Number.MAX_SAFE_INTEGER', () => {
      const result = normaliseContributionScore(
        singleMetric({ value: 10n ** 40n, minimum: 0n, target: 2n * 10n ** 40n })
      );

      assert.strictEqual(result.metrics[0]?.normalisedBps, 5000);
      assert.strictEqual(result.scoreBps, 5000);
    });

    it('stays exact with a large minimum offset', () => {
      const minimum = 10n ** 30n;
      const result = normaliseContributionScore(
        singleMetric({
          value: minimum + 25n * 10n ** 18n,
          minimum,
          target: minimum + 10n ** 20n,
        })
      );

      assert.strictEqual(result.metrics[0]?.normalisedBps, 2500);
    });

    it('returns large raw values unchanged in the breakdown', () => {
      const value = 12345678901234567890123456789n;
      const result = normaliseContributionScore(
        singleMetric({ value, minimum: 0n, target: value })
      );

      assert.strictEqual(result.metrics[0]?.value, value);
      assert.strictEqual(result.metrics[0]?.target, value);
    });
  });

  describe('order independence', () => {
    it('produces an identical result for reordered metrics', () => {
      const metrics: ContributionMetric[] = [
        { key: 'commits', value: 50n, minimum: 0n, target: 100n, weightBps: 5000 },
        { key: 'reviews', value: 30n, minimum: 0n, target: 60n, weightBps: 3000 },
        { key: 'tasks', value: 9n, minimum: 0n, target: 12n, weightBps: 2000 },
      ];

      const ordered = normaliseContributionScore(metrics);
      const shuffled = normaliseContributionScore([
        metrics[2]!,
        metrics[0]!,
        metrics[1]!,
      ]);

      assert.deepStrictEqual(shuffled, ordered);
    });

    it('sorts the breakdown by metric key', () => {
      const result = normaliseContributionScore([
        { key: 'zeta', value: 1n, minimum: 0n, target: 1n, weightBps: 5000 },
        { key: 'alpha', value: 1n, minimum: 0n, target: 1n, weightBps: 5000 },
      ]);

      assert.deepStrictEqual(
        result.metrics.map((metric) => metric.key),
        ['alpha', 'zeta']
      );
    });
  });

  describe('explainability', () => {
    it('returns the inputs alongside the calculated values', () => {
      const result = normaliseContributionScore([
        { key: 'commits', value: 40n, minimum: 10n, target: 90n, weightBps: 10000 },
      ]);

      assert.deepStrictEqual(result.metrics[0], {
        key: 'commits',
        value: 40n,
        minimum: 10n,
        target: 90n,
        weightBps: 10000,
        clamping: 'in-range',
        normalisedBps: 3750,
        weightedScoreBps: 3750,
      });
    });
  });

  describe('validation', () => {
    it('rejects an empty metric list', () => {
      assert.throws(
        () => normaliseContributionScore([]),
        expectValidationError('EMPTY_METRICS')
      );
    });

    it('rejects an empty metric key', () => {
      assert.throws(
        () => normaliseContributionScore(singleMetric({ key: '' })),
        expectValidationError('INVALID_KEY')
      );
    });

    it('rejects duplicate metric keys', () => {
      assert.throws(
        () =>
          normaliseContributionScore([
            { key: 'commits', value: 1n, minimum: 0n, target: 2n, weightBps: 5000 },
            { key: 'commits', value: 2n, minimum: 0n, target: 2n, weightBps: 5000 },
          ]),
        expectValidationError('DUPLICATE_KEY')
      );
    });

    it('rejects a target below the minimum', () => {
      assert.throws(
        () => normaliseContributionScore(singleMetric({ minimum: 100n, target: 10n })),
        expectValidationError('INVALID_RANGE')
      );
    });

    it('rejects a negative value', () => {
      assert.throws(
        () => normaliseContributionScore(singleMetric({ value: -1n })),
        expectValidationError('NEGATIVE_VALUE')
      );
    });

    it('rejects a negative range bound', () => {
      assert.throws(
        () => normaliseContributionScore(singleMetric({ minimum: -10n, target: 10n })),
        expectValidationError('NEGATIVE_RANGE_BOUND')
      );
    });

    it('rejects a non-bigint value supplied from untyped callers', () => {
      assert.throws(
        () =>
          normaliseContributionScore(
            singleMetric({ value: 50 as unknown as bigint })
          ),
        expectValidationError('INVALID_VALUE')
      );
    });

    it('rejects a weight above the full scale', () => {
      assert.throws(
        () => normaliseContributionScore(singleMetric({ weightBps: 10001 })),
        expectValidationError('INVALID_WEIGHT')
      );
    });

    it('rejects a negative weight', () => {
      assert.throws(
        () => normaliseContributionScore(singleMetric({ weightBps: -1 })),
        expectValidationError('INVALID_WEIGHT')
      );
    });

    it('rejects a fractional weight', () => {
      assert.throws(
        () => normaliseContributionScore(singleMetric({ weightBps: 5000.5 })),
        expectValidationError('INVALID_WEIGHT')
      );
    });

    it('rejects weights totalling less than the full scale', () => {
      assert.throws(
        () =>
          normaliseContributionScore([
            { key: 'a', value: 1n, minimum: 0n, target: 2n, weightBps: 5000 },
            { key: 'b', value: 1n, minimum: 0n, target: 2n, weightBps: 4000 },
          ]),
        expectValidationError('INVALID_TOTAL_WEIGHT')
      );
    });

    it('rejects weights totalling more than the full scale', () => {
      assert.throws(
        () =>
          normaliseContributionScore([
            { key: 'a', value: 1n, minimum: 0n, target: 2n, weightBps: 6000 },
            { key: 'b', value: 1n, minimum: 0n, target: 2n, weightBps: 5000 },
          ]),
        expectValidationError('INVALID_TOTAL_WEIGHT')
      );
    });
  });
});
