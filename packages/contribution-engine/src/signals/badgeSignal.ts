/**
 * Badge-count-based contribution signal.
 *
 * Awards points based on the number of badges a member holds.
 * Uses a configurable per-badge point value and optional diminishing returns.
 *
 * Default policy: 5 points per badge, linear (no diminishing returns).
 */

import type { ContributionSignal, SignalContext, SignalResult } from '../types';

export interface BadgeSignalOptions {
  /** Weight multiplier (default: 1.0) */
  weight?: number;
  /** Points awarded per badge (default: 5) */
  pointsPerBadge?: number;
  /** Maximum badges to score (default: Infinity — no cap) */
  maxBadges?: number;
}

export class BadgeSignal implements ContributionSignal {
  readonly type = 'badge_count';
  readonly weight: number;
  private readonly pointsPerBadge: number;
  private readonly maxBadges: number;

  constructor(options?: BadgeSignalOptions) {
    this.weight = options?.weight ?? 1.0;
    this.pointsPerBadge = options?.pointsPerBadge ?? 5;
    this.maxBadges = options?.maxBadges ?? Infinity;
  }

  compute(ctx: SignalContext): SignalResult {
    const cappedBadges = Math.min(ctx.badgeCount, this.maxBadges);
    const rawPoints = cappedBadges * this.pointsPerBadge;
    const points = Math.round(rawPoints * this.weight * 100) / 100;

    const explanation = ctx.badgeCount === 0
      ? 'No badges yet'
      : `${ctx.badgeCount} badge(s) × ${this.pointsPerBadge} pts each`;

    return { type: this.type, points, explanation };
  }
}
