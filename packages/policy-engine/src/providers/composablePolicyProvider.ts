import type { RuleTree } from "@guildpass/shared-types";
import type { RuleProvider, EvaluationContext, EvaluationResult } from "../types";
import { validateRuleTree, getLegacyRuleTemplate } from "../ruleGrammar";
import { evaluateRuleTree } from "../ruleEvaluator";

/**
 * Composable Policy Provider
 *
 * Priority: 200 (mid-range for access policy evaluation)
 *
 * Evaluates access policies expressed as serializable rule tree ASTs (AND/OR/NOT combinators
 * over primitive predicates). Automatically maps legacy static rule types (PUBLIC, MEMBERS_ONLY,
 * ADMINS_ONLY, CONTRIBUTORS_OR_ADMINS) to equivalent pre-built rule tree templates.
 */
export class ComposablePolicyProvider implements RuleProvider {
  name = "ComposablePolicyProvider";
  priority = 200;

  evaluate(context: EvaluationContext): EvaluationResult {
    const { policy } = context;

    let ruleTree: RuleTree | null = null;

    if (policy.params && typeof policy.params === "object" && (policy.params as any).ruleTree) {
      ruleTree = (policy.params as any).ruleTree as RuleTree;
    } else if (policy.ruleType === "COMPOSABLE" || policy.ruleType === "CUSTOM_RULE_TREE") {
      if (policy.params && typeof policy.params === "object" && (policy.params as any).root) {
        ruleTree = policy.params as unknown as RuleTree;
      }
    }

    if (!ruleTree) {
      return {
        result: "ABSTAIN",
        explanation: `Composable policy provider abstains for rule type: ${policy.ruleType}`,
        code: "COMPOSABLE_PROVIDER_ABSTAIN",
      };
    }

    // Sandboxing & cost-bound validation
    const validation = validateRuleTree(ruleTree);
    if (!validation.valid) {
      return {
        result: "DENY",
        explanation: `Malformed rule tree policy: ${validation.errors.join("; ")}`,
        code: "MALFORMED_POLICY",
      };
    }

    // Deterministic evaluation
    const trace = evaluateRuleTree(ruleTree.root, context);

    return {
      result: trace.passed ? "ALLOW" : "DENY",
      explanation: trace.explanation,
      code: trace.code ?? (trace.passed ? "RULE_TREE_ALLOW" : "RULE_TREE_DENY"),
    };
  }
}
