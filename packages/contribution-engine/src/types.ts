/**
 * Contribution Engine - Core Types
 *
 * Defines the pluggable signal-based scoring model for member contributions.
 * Each signal source (e.g. tenure, badges) contributes weighted points to a
 * per-wallet, per-community score that a future rewards or governance system
 * can consume.
 */

/**
 * Context provided to a signal when computing its contribution.
 * Contains the wallet address, community ID, and a snapshot of the
 * member's data needed for scoring.
 */
export interface SignalContext {
  /** Normalised (lowercase) wallet address */
  wallet: string;
  /** Community the member belongs to */
  communityId: string;
  /** ISO-8601 timestamp of when the member joined the community */
  joinedAt: Date;
  /** Number of badges the member currently holds */
  badgeCount: number;
  /** Number of attendance records for the member */
  attendanceCount: number;
  /** Current role assignments (active roles only) */
  roles: string[];
  /** Optional arbitrary metadata for custom signals */
  metadata?: Record<string, unknown>;
}

/**
 * Result returned by a single signal's compute function.
 */
export interface SignalResult {
  /** Unique signal type identifier (e.g. "tenure", "badge_count") */
  type: string;
  /** Weighted point contribution (may be 0) */
  points: number;
  /** Human-readable explanation of how the points were derived */
  explanation: string;
}

/**
 * A pluggable contribution signal source.
 *
 * Implementations compute a weighted point contribution for a single
 * dimension (e.g. membership tenure, badge count). The engine aggregates
 * results from all registered signals into a total score.
 */
export interface ContributionSignal {
  /** Unique signal type identifier */
  readonly type: string;
  /** Weight multiplier applied to the raw score (default: 1.0) */
  readonly weight: number;
  /**
   * Compute the contribution for the given context.
   * @returns SignalResult with points and explanation
   */
  compute(ctx: SignalContext): SignalResult;
}

/**
 * Aggregated contribution score for a wallet in a community.
 */
export interface ContributionScoreResult {
  /** Total aggregated score */
  total: number;
  /** Per-signal breakdown of the score */
  breakdown: Record<string, number>;
  /** Per-signal explanations */
  explanations: Record<string, string>;
}
