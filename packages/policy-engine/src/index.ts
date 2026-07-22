import {
  AccessDecision,
  AccessPolicy,
  AccessOverride,
  DecisionReason,
  RoleContext,
  Role,
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
export { PolicyEngine, createDefaultEngine } from "./engine";
export {
  resolveConflicts,
  buildDecisionReasons,
  DEFAULT_RESOLUTION_CONFIG,
} from "./resolution";
export {
  ValidationProvider,
  StaticPolicyProvider,
  FallbackProvider,
} from "./providers";

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseWallet(value?: string): string | undefined {
  return value ? value.toLowerCase() : undefined;
}

function findActiveOverride(
  ctx: RoleContext,
  policy: AccessPolicy,
): AccessOverride | null {
  const wallet = normaliseWallet(ctx.wallet?.toString());
  const communityId = ctx.communityId ?? policy.communityId;
  const resource = ctx.resource ?? policy.resource;

  if (!wallet || !communityId || !resource) {
    return null;
  }

  const now = new Date();
  const overrides = ctx.overrides ?? [];

  for (const override of overrides) {
    const overrideWallet = normaliseWallet(override.wallet?.toString());
    if (!overrideWallet) continue;
    if (overrideWallet !== wallet) continue;
    if (override.communityId !== communityId) continue;
    if (override.resource !== resource) continue;
    if (override.expiresAt) {
      const expiry = new Date(override.expiresAt);
      if (expiry < now) continue;
    }
    return override;
  }

  return null;
}

function validatePolicy(
  policy: AccessPolicy,
): { valid: true } | { valid: false; message: string } {
  if (policy.params == null) {
    return { valid: true };
  }

  if (!isPlainObject(policy.params)) {
    return { valid: false, message: "Policy params must be a JSON object" };
  }

  return { valid: true };
}

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
 * Evaluate an access policy using the plugin registry (backward compatible)
 */
export function evaluate(
  policy: AccessPolicy,
  ctx: RoleContext,
  options?: EvaluateOptions,
): AccessDecision {
  const effectiveRoles = originalResolveEffectiveRoles(ctx, {
    roleDefinitions: options?.roleDefinitions,
    delegatedGrants: options?.delegatedGrants,
  });
  const pluginRegistry = options?.registry || defaultRegistry;

  // Always start with membership state as reason
  const initialReasons: DecisionReason[] = [
    {
      code: `MEMBERSHIP_${ctx.membershipState.toUpperCase()}`,
      message: `Membership is ${ctx.membershipState}`,
    },
  ];

  // Check access overrides first (highest priority)
  const override = findActiveOverride(ctx, policy);
  if (override) {
    const reasons = [...initialReasons];
    reasons.push({
      code: override.effect === "ALLOW" ? "OVERRIDE_ALLOW" : "OVERRIDE_DENY",
      message: override.reason
        ? `Override applied: ${override.reason}`
        : `Override applied as ${override.effect}`,
    });
    return {
      allowed: override.effect === "ALLOW",
      code: override.effect === "ALLOW" ? "ALLOW" : "DENY",
      reasons,
      effectiveRoles: effectiveRoles as Role[],
      membershipState: ctx.membershipState,
    };
  }

  // Validate policy
  const validation = validatePolicy(policy);
  if (!validation.valid) {
    const reasons = [...initialReasons];
    reasons.push({
      code: "MALFORMED_POLICY",
      message: `Malformed policy: ${validation.message}`,
    });
    return {
      allowed: false,
      code: "DENY",
      reasons,
      effectiveRoles: effectiveRoles as Role[],
      membershipState: ctx.membershipState,
    };
  }

  // Get plugin for rule type
  const plugin = pluginRegistry.get(policy.ruleType);
  if (!plugin) {
    const reasons = [...initialReasons];
    reasons.push({
      code: "RULE_UNHANDLED",
      message: `Unhandled or malformed policy rule: ${policy.ruleType}`,
    });
    return {
      allowed: false,
      code: "DENY",
      reasons,
      effectiveRoles: effectiveRoles as Role[],
      membershipState: ctx.membershipState,
    };
  }

  // Use plugin to evaluate
  return plugin.evaluate(policy, ctx, effectiveRoles as Role[]);
}

/**
 * Explain a policy decision using the plugin registry (backward compatible)
 */
export function explain(
  policy: AccessPolicy,
  ctx: RoleContext,
  registry?: PolicyRulePluginRegistry,
): string {
  const decision = evaluate(policy, ctx, registry);
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
export type {
  PolicyRulePlugin,
  PolicyRulePluginRegistry,
  RuleProvider,
  EvaluationContext,
  EvaluationResult,
  ResolutionConfig,
  PolicyDecision,
} from './types';


