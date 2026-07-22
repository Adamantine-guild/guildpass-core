/**
 * Policy Evaluation Engine
 * 
 * Orchestrates the Chain of Responsibility pattern for policy evaluation.
 * Manages rule providers and coordinates their execution.
 */

declare const require: any;
import type {
  AccessPolicy,
  RoleContext,
  AccessDecision,
  DecisionReason,
  Role,
  AccessOverride,
  RoleDefinition,
  DelegatedGrant,
} from '@guildpass/shared-types';
import type { RuleProvider, EvaluationContext, ResolutionConfig, EvaluationResult } from './types';
import { resolveConflicts, buildDecisionReasons, DEFAULT_RESOLUTION_CONFIG } from './resolution';
import { resolveEffectiveRoles } from './roles';

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


/**
 * PolicyEngine manages rule providers and orchestrates policy evaluation
 */
export class PolicyEngine {
  private providers: RuleProvider[] = [];
  private resolutionConfig: ResolutionConfig;

  constructor(
    providers: RuleProvider[] = [],
    resolutionConfig: ResolutionConfig = DEFAULT_RESOLUTION_CONFIG,
  ) {
    this.providers = [...providers].sort((a, b) => b.priority - a.priority);
    this.resolutionConfig = resolutionConfig;
  }

  /**
   * Add a rule provider to the engine
   * Providers are automatically sorted by priority (highest first)
   */
  addProvider(provider: RuleProvider): void {
    this.providers.push(provider);
    this.providers.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remove a rule provider by name
   */
  removeProvider(name: string): boolean {
    const initialLength = this.providers.length;
    this.providers = this.providers.filter(p => p.name !== name);
    return this.providers.length < initialLength;
  }

  /**
   * Get all registered providers (sorted by priority)
   */
  getProviders(): ReadonlyArray<RuleProvider> {
    return this.providers;
  }

  /**
   * Evaluate an access policy against a role context
   * 
   * This is the main entry point that:
   * 1. Resolves effective roles from the role context
   * 2. Creates an evaluation context
   * 3. Runs all providers in priority order
   * 4. Resolves conflicts and builds final decision
   * 
   * @param policy - The access policy to evaluate
   * @param roleContext - The user's role and membership context
   * @returns AccessDecision with allow/deny and detailed reasons
   */
  evaluate(
    policy: AccessPolicy,
    roleContext: RoleContext,
    options?: {
      roleDefinitions?: RoleDefinition[];
      delegatedGrants?: DelegatedGrant[];
    }
  ): AccessDecision {
    // Resolve effective roles (includes hierarchy and membership state).
    const effectiveRoles = resolveEffectiveRoles(roleContext, {
      roleDefinitions: options?.roleDefinitions,
      delegatedGrants: options?.delegatedGrants,
    }) as Role[];

    // Build evaluation context
    const context: EvaluationContext = {
      policy,
      roleContext,
      effectiveRoles,
    };

    // Collect membership state reason (for audit/debugging)
    const contextReasons: DecisionReason[] = [
      {
        code: `MEMBERSHIP_${roleContext.membershipState.toUpperCase()}`,
        message: `Membership is ${roleContext.membershipState}`,
      },
    ];

    // Check access overrides first (highest priority)
    const override = findActiveOverride(roleContext, policy);
    if (override) {
      const reasons = [...contextReasons];
      reasons.push({
        code: override.effect === 'ALLOW' ? 'OVERRIDE_ALLOW' : 'OVERRIDE_DENY',
        message: override.reason
          ? `Override applied: ${override.reason}`
          : `Override applied as ${override.effect}`,
      });
      return {
        allowed: override.effect === 'ALLOW',
        code: override.effect === 'ALLOW' ? 'ALLOW' : 'DENY',
        reasons,
        effectiveRoles,
        membershipState: roleContext.membershipState,
      };
    }

    // Execute all providers in priority order
    const results: EvaluationResult[] = [];
    for (const provider of this.providers) {
      try {
        const res = provider.evaluate(context);
        results.push(res);
        if (res.code === 'MALFORMED_POLICY') {
          break;
        }
      } catch (error) {
        // If a provider throws, treat it as abstain and log the error
        console.error(`Provider ${provider.name} threw error:`, error);
        results.push({
          result: 'ABSTAIN' as const,
          explanation: `Provider ${provider.name} encountered an error`,
          code: 'PROVIDER_ERROR',
        });
      }
    }

    // Resolve conflicts to get final decision
    const resolution = resolveConflicts(results, this.resolutionConfig);

    // Build decision reasons from provider results
    const providerReasons = buildDecisionReasons(results);

    // Combine all reasons
    const allReasons = [...contextReasons, ...providerReasons];

    // Return final access decision
    return {
      allowed: resolution.decision === 'ALLOW',
      code: resolution.decision,
      reasons: allReasons,
      effectiveRoles,
      membershipState: roleContext.membershipState,
    };
  }
}

/**
 * Create a default policy engine with standard providers
 * This provides the same behavior as the original implementation
 */
export function createDefaultEngine(): PolicyEngine {
  // Lazy load providers to avoid circular dependencies
  const { ValidationProvider } = require('./providers/validationProvider');
  const { StaticPolicyProvider } = require('./providers/staticPolicyProvider');
  const { FallbackProvider } = require('./providers/fallbackProvider');

  return new PolicyEngine([
    new ValidationProvider(),
    new StaticPolicyProvider(),
    new FallbackProvider(),
  ]);
}
