/**
 * Constitutional Rule Engine - Core Orchestrator
 */

import {
  ConstitutionalRule,
  ConstitutionalRuleSet,
  EvaluationResult,
  EvaluationTrace,
  MutationContext,
} from './types';
import { evaluateCooldownRule } from './rules/cooldownRule';
import { evaluateMultiAdminApprovalRule } from './rules/multiAdminApprovalRule';
import { validateRuleSet } from './ast';

export class ConstitutionalEngine {
  /**
   * Evaluate a mutation context against a versioned constitutional rule set
   */
  public evaluate(
    ruleSet: ConstitutionalRuleSet,
    context: MutationContext,
    now: Date = new Date(),
  ): EvaluationResult {
    // Validate rule set structure
    const validation = validateRuleSet(ruleSet);
    if (!validation.valid) {
      const errorMsg = validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      return {
        allowed: false,
        code: 'CONSTITUTIONAL_DENY',
        reasons: [{ code: 'INVALID_RULESET', message: `Invalid constitutional rule set: ${errorMsg}` }],
        traces: [],
      };
    }

    // Filter matching active rules for this mutation action
    const matchingRules = ruleSet.rules.filter((rule) => {
      if (rule.active === false) return false;
      return rule.targetAction === '*' || rule.targetAction === context.action;
    });

    // Sort matching rules by precedence descending (highest priority first)
    matchingRules.sort((a, b) => b.precedence - a.precedence);

    if (matchingRules.length === 0) {
      return {
        allowed: true,
        code: 'CONSTITUTIONAL_ALLOW',
        reasons: [
          {
            code: 'NO_MATCHING_RULES',
            message: `No active constitutional rules configured for action "${context.action}" in community "${context.communityId}"`,
          },
        ],
        traces: [],
      };
    }

    const traces: EvaluationTrace[] = [];
    const reasons: Array<{ code: string; message: string }> = [];

    let overallAllowed = true;
    let overallCode: 'CONSTITUTIONAL_ALLOW' | 'CONSTITUTIONAL_DENY' | 'APPROVAL_REQUIRED' =
      'CONSTITUTIONAL_ALLOW';

    for (const rule of matchingRules) {
      let trace: EvaluationTrace;

      if (rule.type === 'COOLDOWN') {
        trace = evaluateCooldownRule(rule, context, now);
      } else if (rule.type === 'MULTI_ADMIN_APPROVAL') {
        trace = evaluateMultiAdminApprovalRule(rule, context, now);
      } else {
        // Generic fallback for custom rules
        trace = {
          ruleId: rule.id,
          ruleName: rule.name,
          targetAction: rule.targetAction,
          passed: true,
          effect: rule.effect,
          details: `Custom rule "${rule.name}" evaluated`,
        };
      }

      traces.push(trace);

      if (!trace.passed) {
        overallAllowed = false;
        if (rule.effect === 'REQUIRE_APPROVAL') {
          overallCode = 'APPROVAL_REQUIRED';
          reasons.push({
            code: 'CONSTITUTIONAL_APPROVAL_REQUIRED',
            message: trace.details,
          });
        } else {
          overallCode = 'CONSTITUTIONAL_DENY';
          reasons.push({
            code: 'CONSTITUTIONAL_VIOLATION',
            message: trace.details,
          });
        }
      }
    }

    if (overallAllowed) {
      reasons.push({
        code: 'CONSTITUTIONAL_PASS',
        message: `All ${matchingRules.length} matching constitutional rules passed for action "${context.action}"`,
      });
    }

    return {
      allowed: overallAllowed,
      code: overallCode,
      reasons,
      traces,
    };
  }

  /**
   * Format evaluation result traces as human-readable text
   */
  public formatTrace(result: EvaluationResult): string {
    const lines: string[] = [
      `Constitutional Evaluation Result: ${result.code} (Allowed: ${result.allowed})`,
      'Reasons:',
      ...result.reasons.map((r) => `  - [${r.code}] ${r.message}`),
      'Evaluation Traces:',
    ];

    if (result.traces.length === 0) {
      lines.push('  (No matching rules evaluated)');
    } else {
      result.traces.forEach((t, i) => {
        const symbol = t.passed ? '✓' : '✗';
        lines.push(
          `  ${i + 1}. [${symbol}] Rule "${t.ruleName}" (${t.ruleId}) - Precedence Target: ${t.targetAction}`,
        );
        lines.push(`     Effect: ${t.effect} | Details: ${t.details}`);
        if (t.metadata) {
          lines.push(`     Metadata: ${JSON.stringify(t.metadata)}`);
        }
      });
    }

    return lines.join('\n');
  }
}
