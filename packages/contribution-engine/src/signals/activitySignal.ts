/**
 * Attendance-based contribution signal with exponential time-decay.
 *
 * Awards points per attendance event, decaying older events exponentially.
 * Recent participation is weighted more heavily than distant participation,
 * preventing score inflation from stale activity while still rewarding
 * sustained engagement.
 *
 * Default policy: 10 points per event, half-life of 30 days.
 *   score = sum( pointsPerEvent * decay( daysSinceEvent ) )
 *   decay(d) = 2^(-d / halfLifeDays)
 */

import type { ContributionSignal, SignalContext, SignalResult } from '../types';

export interface ActivitySignalOptions {
  /** Weight multiplier (default: 1.0) */
  weight?: number;
  /** Points awarded per attendance event (default: 10) */
  pointsPerEvent?: number;
  /** Half-life in days — events this old contribute half their points (default: 30) */
  halfLifeDays?: number;
  /** Optional cap on the number of most-recent events scored (default: no cap) */
  maxEvents?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POINTS_PER_EVENT = 10;
const DEFAULT_HALF_LIFE_DAYS = 30;

function decayFactor(elapsedDays: number, halfLifeDays: number): number {
  // 2^(-d / halfLife) — standard exponential decay
  return Math.pow(2, -elapsedDays / halfLifeDays);
}

/**
 * ActivitySignal computes a decay-weighted attendance score.
 *
 * Since the current `SignalContext` only carries an `attendanceCount` (not
 * individual event timestamps), this signal applies an *aggregate* decay
 * approximation: the member's effective activity score is computed as
 *   attendanceCount * pointsPerEvent * avgDecayFactor
 * where avgDecayFactor models the expected average decay over the member's
 * tenure assuming roughly uniform activity.
 *
 * This is a deliberate simplification that avoids requiring per-event
 * timestamp queries while still producing meaningful, time-decayed scores.
 * A future enhancement could replace this with per-event scoring if the
 * `SignalContext` is extended with event timestamps.
 */
export class ActivitySignal implements ContributionSignal {
  readonly type = 'activity';
  readonly weight: number;
  private readonly pointsPerEvent: number;
  private readonly halfLifeDays: number;
  private readonly maxEvents: number;

  constructor(options?: ActivitySignalOptions) {
    this.weight = options?.weight ?? 1.0;
    this.pointsPerEvent = options?.pointsPerEvent ?? DEFAULT_POINTS_PER_EVENT;
    this.halfLifeDays = options?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
    this.maxEvents = options?.maxEvents ?? Infinity;
  }

  compute(ctx: SignalContext): SignalResult {
    if (ctx.attendanceCount === 0) {
      return { type: this.type, points: 0, explanation: 'No attendance events recorded' };
    }

    const cappedCount = Math.min(ctx.attendanceCount, this.maxEvents);

    // Calculate the member's tenure in days for the decay model.
    const now = Date.now();
    const joinedMs = ctx.joinedAt.getTime();
    const tenureDays = Math.max(0, (now - joinedMs) / DAY_MS);

    // Approximate the average decay factor over the member's tenure:
    // events are assumed to be roughly uniformly distributed over the
    // membership period, so the average decay is the integral of
    // 2^(-t/halfLife) over [0, tenureDays] divided by tenureDays.
    let avgDecay: number;
    if (tenureDays <= 0) {
      avgDecay = 1;
    } else {
      // Integral of 2^(-t/H) from 0 to T  =  H/ln2 * (1 - 2^(-T/H))
      // Divide by T to get the average.
      const halfLifeLn2 = this.halfLifeDays * Math.LN2;
      const rawPoints = cappedCount * this.pointsPerEvent;
      avgDecay =
        (halfLifeLn2 / tenureDays) *
        (1 - Math.pow(2, -tenureDays / this.halfLifeDays));
    }

    const rawPoints = cappedCount * this.pointsPerEvent * avgDecay;
    const points = Math.round(rawPoints * this.weight * 100) / 100;

    let explanation: string;
    if (cappedCount === ctx.attendanceCount) {
      explanation = `${cappedCount} attendance event(s) × ${this.pointsPerEvent} pts (decayed, half-life ${this.halfLifeDays}d)`;
    } else {
      explanation = `${ctx.attendanceCount} event(s) capped to ${cappedCount} × ${this.pointsPerEvent} pts (decayed)`;
    }

    return { type: this.type, points, explanation };
  }
}
