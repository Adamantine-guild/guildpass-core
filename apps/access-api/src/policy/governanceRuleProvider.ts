/**
 * GovernanceRuleProvider
 *
 * Bridges the AST-based Constitutional Rule Engine (`@guildpass/governance-engine`)
 * into the Chain-of-Responsibility policy engine (`@guildpass/policy-engine`) as a
 * pluggable {@link RuleProvider}.
 *
 * Design notes:
 *  - Lives in `apps/access-api` (not `packages/policy-engine`) because governance
 *    rules are DB-backed and pulling Prisma / governance-engine into the pure
 *    policy-engine package would invert the dependency graph. The provider only
 *    depends on the policy-engine *types*.
 *  - `RuleProvider.evaluate` is synchronous, so the DB work (loading active rules
 *    and the contribution score) happens *before* construction; the provider is
 *    seeded with that already-resolved state and evaluates purely in-memory.
 *  - Priority sits in the documented "500-999: Custom governance rules" band.
 *  - When a community has no active governance rule for the resource the provider
 *    ABSTAINs, guaranteeing zero behavioural change for the vast majority of
 *    resources (full backward compatibility).
 */

import type {
  RuleProvider,
  EvaluationContext,
  EvaluationResult as PolicyEvaluationResult,
} from '@guildpass/policy-engine';
import {
  RuleNode,
  ContributionScore,
  ApprovalRecord,
  createGovernanceContext,
  evaluateRule,
  DEFAULT_CONTRIBUTION_SCORE,
} from '@guildpass/governance-engine';

export const DEFAULT_GOVERNANCE_PRIORITY = 500;

export interface ActiveGovernanceRule {
  id: string;
  name: string;
  resource: string;
  ast: RuleNode;
}

export interface GovernanceRuleProviderOptions {
  rules: ActiveGovernanceRule[];
  wallet: string;
  communityId: string;
  contributionScore?: ContributionScore;
  approvals?: ApprovalRecord[];
  priority?: number;
}

export class GovernanceRuleProvider implements RuleProvider {
  readonly name = 'GovernanceRuleProvider';
  readonly priority: number;

  private readonly rules: ActiveGovernanceRule[];
  private readonly wallet: string;
  private readonly communityId: string;
  private readonly contributionScore: ContributionScore;
  private readonly approvals: ApprovalRecord[];

  constructor(options: GovernanceRuleProviderOptions) {
    this.rules = options.rules;
    this.wallet = options.wallet;
    this.communityId = options.communityId;
    this.contributionScore = options.contributionScore ?? DEFAULT_CONTRIBUTION_SCORE;
    this.approvals = options.approvals ?? [];
    this.priority = options.priority ?? DEFAULT_GOVERNANCE_PRIORITY;
  }

  evaluate(context: EvaluationContext): PolicyEvaluationResult {
    if (this.rules.length === 0) {
      return {
        result: 'ABSTAIN',
        explanation: 'No active governance rules for this resource',
        code: 'GOVERNANCE_NO_RULES',
      };
    }

    const governanceContext = createGovernanceContext(
      this.wallet,
      this.communityId,
      context.roleContext,
      this.contributionScore,
      this.approvals,
    );

    const failures: string[] = [];
    for (const rule of this.rules) {
      const result = evaluateRule(rule.ast, governanceContext);
      if (!result.allowed) {
        failures.push(`${rule.name}: ${result.trace.details}`);
      }
    }

    if (failures.length > 0) {
      return {
        result: 'DENY',
        explanation: `Governance rule(s) denied access — ${failures.join('; ')}`,
        code: 'GOVERNANCE_DENY',
      };
    }

    return {
      result: 'ALLOW',
      explanation: `All ${this.rules.length} governance rule(s) granted access`,
      code: 'GOVERNANCE_ALLOW',
    };
  }
}
