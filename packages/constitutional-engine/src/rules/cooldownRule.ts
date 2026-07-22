/**
 * Reference Constitutional Rule #1: Cooldown Rule
 *
 * Enforces a minimum elapsed duration between consecutive state mutations
 * for a target wallet, resource, or community.
 */

import {
  ConstitutionalRule,
  CooldownParams,
  EvaluationTrace,
  MutationContext,
} from '../types';

export function evaluateCooldownRule(
  rule: ConstitutionalRule,
  context: MutationContext,
  now: Date = new Date(),
): EvaluationTrace {
  const params = rule.params as CooldownParams;
  const minIntervalMs = (params.minIntervalSeconds || 0) * 1000;

  if (!context.previousMutationTimestamp) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      targetAction: rule.targetAction,
      passed: true,
      effect: rule.effect,
      details: `Cooldown passed: No previous mutation recorded for this target in community ${context.communityId}`,
      metadata: {
        minIntervalSeconds: params.minIntervalSeconds,
        elapsedSeconds: null,
      },
    };
  }

  const prevTime = new Date(context.previousMutationTimestamp).getTime();
  const currentTime = now.getTime();
  const elapsedMs = currentTime - prevTime;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const remainingSeconds = Math.max(0, params.minIntervalSeconds - elapsedSeconds);

  const passed = elapsedMs >= minIntervalMs;

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    targetAction: rule.targetAction,
    passed,
    effect: rule.effect,
    details: passed
      ? `Cooldown passed: ${elapsedSeconds}s elapsed since last mutation (minimum interval: ${params.minIntervalSeconds}s)`
      : `Cooldown violation: Only ${elapsedSeconds}s elapsed since last mutation. Cooldown requires ${params.minIntervalSeconds}s (${remainingSeconds}s remaining)`,
    metadata: {
      minIntervalSeconds: params.minIntervalSeconds,
      elapsedSeconds,
      remainingSeconds,
      previousMutationTimestamp: context.previousMutationTimestamp,
    },
  };
}
