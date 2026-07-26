/**
 * Core types for the Chain of Responsibility policy evaluation architecture
 */

import type { RoleContext, AccessPolicy, Role, AccessDecision, DecisionReason } from '@guildpass/shared-types';

/**
 * The three possible outcomes of a rule provider evaluation
 */
export type PolicyDecision = 'ALLOW' | 'DENY' | 'ABSTAIN';

/**
 * Result of a single rule provider's evaluation
 */
export interface EvaluationResult {
  /** The decision made by this provider */
  result: PolicyDecision;
  /** Human-readable explanation of why this decision was made */
  explanation: string;
  /** Optional reason code for structured logging/auditing */
  code?: string;
}

/**
 * Context provided to all rule providers during evaluation
 */
export interface EvaluationContext {
  /** The policy being evaluated */
  policy: AccessPolicy;
  /** The user's role and membership context */
  roleContext: RoleContext;
  /** The effective roles resolved from the role context */
  effectiveRoles: Role[];
}

/**
 * Interface that all rule providers must implement
 */
export interface RuleProvider {
  /** Unique identifier for this provider (used in logging/debugging) */
  name: string;
  /** 
   * Priority determines execution order (higher = evaluated first)
   * Recommended ranges:
   * - 1000+: System overrides (manual overrides, emergency access)
   * - 500-999: Custom governance rules
   * - 100-499: Static policy rules
   * - 0-99: Default/fallback rules
   */
  priority: number;
  /**
   * Evaluate whether access should be granted based on this provider's rules
   * @returns EvaluationResult with ALLOW, DENY, or ABSTAIN
   */
  evaluate(context: EvaluationContext): EvaluationResult;
}

/**
 * Configuration for the conflict resolution strategy
 */
export interface ResolutionConfig {
  /** 
   * If true, any DENY result will override all ALLOW results
   * This is the secure default for most access control systems
   */
  denyOverridesAllow: boolean;
}

/**
 * Policy Rule Plugin interface (per ruleType implementation)
 */
export interface PolicyRulePlugin {
  /** Unique rule type this plugin handles (e.g., 'PUBLIC', 'MY_CUSTOM_RULE') */
  readonly type: string;
  /** Evaluate this rule against the given context */
  evaluate(policy: AccessPolicy, context: RoleContext, effectiveRoles: Role[]): AccessDecision;
  /** Provide human-readable explanation for this rule's evaluation */
  explain(policy: AccessPolicy, context: RoleContext, effectiveRoles: Role[]): string;
}

/**
 * Policy Rule Plugin Registry
 * Enforces unique rule type registration
 */
export class PolicyRulePluginRegistry {
  private plugins = new Map<string, PolicyRulePlugin>();

  /** Register a new policy rule plugin */
  register(plugin: PolicyRulePlugin): void {
    if (this.plugins.has(plugin.type)) {
      throw new Error(`Plugin for rule type '${plugin.type}' is already registered`);
    }
    this.plugins.set(plugin.type, plugin);
  }

  /** Unregister a policy rule plugin */
  unregister(type: string): boolean {
    return this.plugins.delete(type);
  }

  /** Get a plugin by rule type */
  get(type: string): PolicyRulePlugin | undefined {
    return this.plugins.get(type);
  }

  /** Check if a rule type is registered */
  has(type: string): boolean {
    return this.plugins.has(type);
  }

  /** List all registered rule types */
  listTypes(): string[] {
    return Array.from(this.plugins.keys());
  }

  /** Get all registered plugins */
  listPlugins(): PolicyRulePlugin[] {
    return Array.from(this.plugins.values());
  }
}
