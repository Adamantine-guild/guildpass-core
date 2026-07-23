/**
 * Contribution Engine
 *
 * Aggregates pluggable signal sources into a per-wallet, per-community
 * contribution score. Designed for incremental, event-driven recomputation
 * rather than batch reprocessing.
 */

import type {
  ContributionSignal,
  ContributionScoreResult,
  SignalContext,
} from './types';

/**
 * Registry of contribution signals and scoring engine.
 */
export class ContributionEngine {
  private signals: ContributionSignal[] = [];

  /**
   * Register a signal source.
   * @throws if a signal with the same type is already registered.
   */
  register(signal: ContributionSignal): void {
    if (this.signals.some((s) => s.type === signal.type)) {
      throw new Error(`Signal type '${signal.type}' is already registered`);
    }
    this.signals.push(signal);
  }

  /**
   * Unregister a signal by type.
   * @returns true if removed, false if not found.
   */
  unregister(type: string): boolean {
    const idx = this.signals.findIndex((s) => s.type === type);
    if (idx === -1) return false;
    this.signals.splice(idx, 1);
    return true;
  }

  /**
   * Get a registered signal by type.
   */
  getSignal(type: string): ContributionSignal | undefined {
    return this.signals.find((s) => s.type === type);
  }

  /**
   * List all registered signal types.
   */
  listSignalTypes(): string[] {
    return this.signals.map((s) => s.type);
  }

  /**
   * Compute the aggregated contribution score for a wallet/community pair.
   */
  computeScore(ctx: SignalContext): ContributionScoreResult {
    const breakdown: Record<string, number> = {};
    const explanations: Record<string, string> = {};
    let total = 0;

    for (const signal of this.signals) {
      const result = signal.compute(ctx);
      breakdown[result.type] = result.points;
      explanations[result.type] = result.explanation;
      total += result.points;
    }

    total = Math.round(total * 100) / 100;

    return { total, breakdown, explanations };
  }
}

/**
 * Create a ContributionEngine with the two built-in signals registered:
 * - tenure: points for membership duration
 * - badge_count: points for badge count
 */
export function createDefaultEngine(): ContributionEngine {
  // Lazy import to avoid circular deps; the engine is self-contained
  // but we import signals here so consumers don't have to.
  const { TenureSignal } = require('./signals/tenureSignal');
  const { BadgeSignal } = require('./signals/badgeSignal');

  const engine = new ContributionEngine();
  engine.register(new TenureSignal());
  engine.register(new BadgeSignal());
  return engine;
}
