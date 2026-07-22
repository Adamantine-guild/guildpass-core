import type { RuleProvider, EvaluationContext, EvaluationResult, PolicyRulePluginRegistry } from '../types';

export class RegistryRuleProvider implements RuleProvider {
  name = 'RegistryRuleProvider';
  priority = 200; // Same priority as StaticPolicyProvider
  private registry: PolicyRulePluginRegistry;

  constructor(registry: PolicyRulePluginRegistry) {
    this.registry = registry;
  }

  evaluate(context: EvaluationContext): EvaluationResult {
    const { policy, roleContext, effectiveRoles } = context;
    const plugin = this.registry.get(policy.ruleType);
    if (!plugin) {
      return {
        result: 'ABSTAIN',
        explanation: `Registry does not handle rule type: ${policy.ruleType}`,
        code: 'REGISTRY_PROVIDER_ABSTAIN',
      };
    }
    const decision = plugin.evaluate(policy, roleContext, effectiveRoles);
    // Convert AccessDecision to EvaluationResult by taking the last reason's code/message
    const lastReason = decision.reasons[decision.reasons.length - 1];
    return {
      result: decision.allowed ? 'ALLOW' : 'DENY',
      explanation: lastReason?.message || (decision.allowed ? 'Access allowed by registry' : 'Access denied by registry'),
      code: lastReason?.code || (decision.allowed ? 'REGISTRY_ALLOW' : 'REGISTRY_DENY'),
    };
  }
}
