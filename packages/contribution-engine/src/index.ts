/**
 * Contribution Engine
 *
 * A minimal, extensible scoring model for member contributions.
 * Pluggable "signal" sources each contribute weighted points to a
 * per-wallet, per-community score, computed and persisted incrementally.
 */

// Core types
export type {
  ContributionSignal,
  ContributionScoreResult,
  SignalContext,
  SignalResult,
} from './types';

// Engine
export { ContributionEngine, createDefaultEngine } from './engine';

// Built-in signals
export { TenureSignal } from './signals/tenureSignal';
export type { TenureSignalOptions } from './signals/tenureSignal';
export { BadgeSignal } from './signals/badgeSignal';
export type { BadgeSignalOptions } from './signals/badgeSignal';
