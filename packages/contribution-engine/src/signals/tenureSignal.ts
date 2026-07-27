/**
 * Tenure-based contribution signal.
 *
 * Awards points proportional to how long a member has been part of a
 * community. Uses a linear scale capped at a configurable maximum tenure.
 *
 * Default policy: 1 point per week of membership, up to a cap (52 weeks = 52 points).
 */

import type { ContributionSignal, SignalContext, SignalResult } from '../types';

export interface TenureSignalOptions {
  /** Weight multiplier (default: 1.0) */
  weight?: number;
  /** Points awarded per week of membership (default: 1) */
  pointsPerWeek?: number;
  /** Maximum tenure in weeks to score (default: 52) */
  maxWeeks?: number;
}

const DEFAULT_POINTS_PER_WEEK = 1;
const DEFAULT_MAX_WEEKS = 52;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export class TenureSignal implements ContributionSignal {
  readonly type = 'tenure';
  readonly weight: number;
  private readonly pointsPerWeek: number;
  private readonly maxWeeks: number;

  constructor(options?: TenureSignalOptions) {
    this.weight = options?.weight ?? 1.0;
    this.pointsPerWeek = options?.pointsPerWeek ?? DEFAULT_POINTS_PER_WEEK;
    this.maxWeeks = options?.maxWeeks ?? DEFAULT_MAX_WEEKS;
  }

  compute(ctx: SignalContext): SignalResult {
    const now = Date.now();
    const joinedMs = ctx.joinedAt.getTime();
    const elapsedMs = now - joinedMs;

    if (elapsedMs < 0) {
      return { type: this.type, points: 0, explanation: 'Membership not yet started' };
    }

    const elapsedWeeks = Math.floor(elapsedMs / WEEK_MS);
    const cappedWeeks = Math.min(elapsedWeeks, this.maxWeeks);
    const rawPoints = cappedWeeks * this.pointsPerWeek;
    const points = Math.round(rawPoints * this.weight * 100) / 100;

    const explanation = elapsedWeeks >= this.maxWeeks
      ? `Maximum tenure reached: ${this.maxWeeks} weeks`
      : `${elapsedWeeks} week(s) of membership`;

    return { type: this.type, points, explanation };
  }
}
