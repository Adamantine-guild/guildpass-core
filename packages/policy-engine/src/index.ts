import {
  AccessDecision,
  AccessPolicy,
  AccessOverride,
  DecisionReason,
  RoleContext,
  Role,
  RoleDefinition,
  DelegatedGrant,
} from "@guildpass/shared-types";
import { resolveEffectiveRoles as originalResolveEffectiveRoles } from "./roles";
import {
  PolicyRulePlugin,
  PolicyRulePluginRegistry,
} from "./types";
import {
  PublicRule,
  MembersOnlyRule,
  AdminsOnlyRule,
  ContributorsOrAdminsRule,
} from "./rules";
import { PolicyEngine, createDefaultEngine } from "./engine";
import {
  ValidationProvider,
  FallbackProvider,
  RegistryRuleProvider,
} from "./providers";


// Re-export for backward compatibility
export { resolveEffectiveRoles } from "./roles";
export {
  PolicyEngine,
  createDefaultEngine,
} from "./engine";

export type {
  RuleProvider,
  EvaluationContext,
  EvaluationResult,
  PolicyDecision,
  ResolutionConfig,
} from "./types";
export {
  resolveConflicts,
  buildDecisionReasons,
  DEFAULT_RESOLUTION_CONFIG,
} from "./resolution";
export {
  ValidationProvider,
  StaticPolicyProvider,
  FallbackProvider,
  RegistryRuleProvider,
} from "./providers";

/**
 * Create a default plugin registry with all built-in rules registered
 */
export function createDefaultRegistry(): PolicyRulePluginRegistry {
  const registry = new PolicyRulePluginRegistry();
  registry.register(new PublicRule());
  registry.register(new MembersOnlyRule());
  registry.register(new AdminsOnlyRule());
  registry.register(new ContributorsOrAdminsRule());
  return registry;
}

// Default registry instance
const defaultRegistry = createDefaultRegistry();

/**
 * Get the default plugin registry
 */
export function getDefaultRegistry(): PolicyRulePluginRegistry {
  return defaultRegistry;
}

/**
 * Evaluate options, including role definitions and delegated grants
 */
export interface EvaluateOptions {
  registry?: PolicyRulePluginRegistry;
  roleDefinitions?: RoleDefinition[];
  delegatedGrants?: DelegatedGrant[];
}

/**
 * Evaluate an access policy using the plugin registry (backward compatible wrapper)
 * @deprecated Use PolicyEngine or createDefaultEngine().evaluate() instead.
 */
export function evaluate(
  policy: AccessPolicy,
  ctx: RoleContext,
  options?: EvaluateOptions,
): AccessDecision {
  if (options?.registry) {
    const engine = new PolicyEngine([
      new ValidationProvider(),
      new RegistryRuleProvider(options.registry),
      new FallbackProvider(options.registry.listTypes()),
    ]);
    return engine.evaluate(policy, ctx, {
      roleDefinitions: options.roleDefinitions,
      delegatedGrants: options.delegatedGrants,
    });
  }

  const engine = createDefaultEngine();
  return engine.evaluate(policy, ctx, {
    roleDefinitions: options?.roleDefinitions,
    delegatedGrants: options?.delegatedGrants,
  });
}

/**
 * Explain a policy decision using the plugin registry (backward compatible wrapper)
 * @deprecated Use PolicyEngine or createDefaultEngine().evaluate() instead.
 */
export function explain(
  policy: AccessPolicy,
  ctx: RoleContext,
  registry?: PolicyRulePluginRegistry,
): string {
  const decision = evaluate(policy, ctx, registry ? { registry } : undefined);
  const status = decision.allowed ? 'ALLOWED' : 'DENIED';
  const paramsString = policy.params
    ? ` params=${JSON.stringify(policy.params)}`
    : '';
  const lines = [
    `${status} for ruleType=${policy.ruleType}${paramsString}`,
    `roles=[${(decision.effectiveRoles || []).join(', ')}]`,
    ...decision.reasons.map((r) => `- ${r.code}: ${r.message}`),
  ];
  return lines.join('\n');
}

// Re-export types
export type { PolicyRulePlugin } from './types';
export { PolicyRulePluginRegistry } from './types';


