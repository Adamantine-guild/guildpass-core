/**
 * Conflict Resolution Strategy
 * 
 * Implements the core decision logic that combines results from multiple
 * rule providers into a single, authoritative access decision.
 */

import type { EvaluationResult, ResolutionConfig } from './types';
import type { DecisionReason } from '@guildpass/shared-types';

/**
 * Default resolution configuration
 * Uses "deny overrides allow" strategy for security
 */
export const DEFAULT_RESOLUTION_CONFIG: ResolutionConfig = {
  denyOverridesAllow: true,
};

/**
 * Resolves multiple evaluation results into a single access decision
 * 
 * Resolution strategy:
 * 1. If denyOverridesAllow is true and any provider returned DENY, deny access
 * 2. If any provider returned ALLOW, allow access
 * 3. If all providers returned ABSTAIN, deny access (fail-secure)
 * 
 * @param results - Array of evaluation results from all providers
 * @param config - Resolution configuration
 * @returns Final access decision
 */
export function resolveConflicts(
  results: EvaluationResult[],
  config: ResolutionConfig = DEFAULT_RESOLUTION_CONFIG,
): { decision: 'ALLOW' | 'DENY'; explanation: string } {
  // Separate results by decision type
  const denies = results.filter(r => r.result === 'DENY');
  const allows = results.filter(r => r.result === 'ALLOW');
  // Strategy 1: Deny overrides allow (if configured)
  if (config.denyOverridesAllow && denies.length > 0) {
    const denyExplanations = denies.map(r => r.explanation).join('; ');
    return {
      decision: 'DENY',
      explanation: `Access denied: ${denyExplanations}`,
    };
  }

  // Strategy 2: Any allow grants access
  if (allows.length > 0) {
    const allowExplanations = allows.map(r => r.explanation).join('; ');
    return {
      decision: 'ALLOW',
      explanation: `Access granted: ${allowExplanations}`,
    };
  }

  // Strategy 3: If we have denies but denyOverridesAllow is false
  if (denies.length > 0) {
    const denyExplanations = denies.map(r => r.explanation).join('; ');
    return {
      decision: 'DENY',
      explanation: `Access denied: ${denyExplanations}`,
    };
  }

  // Default: All abstained, fail secure
  return {
    decision: 'DENY',
    explanation: 'No rule provider granted access (all abstained)',
  };
}

/**
 * Converts evaluation results into structured DecisionReason objects
 * for inclusion in the final AccessDecision
 * 
 * @param results - Array of evaluation results from providers
 * @returns Array of DecisionReason objects
 */
export function buildDecisionReasons(results: EvaluationResult[]): DecisionReason[] {
  return results
    .filter(r => r.result !== 'ABSTAIN') // Only include actual decisions
    .map(r => ({
      code: r.code || `PROVIDER_${r.result}`,
      message: r.explanation,
    }));
}
