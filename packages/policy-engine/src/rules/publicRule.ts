import { AccessPolicy, RoleContext, Role, AccessDecision, DecisionReason } from '@guildpass/shared-types';
import { PolicyRulePlugin } from '../types';

export class PublicRule implements PolicyRulePlugin {
  readonly type = 'PUBLIC';

  evaluate(policy: AccessPolicy, context: RoleContext, effectiveRoles: Role[]): AccessDecision {
    const reasons: DecisionReason[] = [
      {
        code: `MEMBERSHIP_${context.membershipState.toUpperCase()}`,
        message: `Membership is ${context.membershipState}`,
      },
      { code: 'RULE_PUBLIC', message: 'Resource is public' },
    ];

    return {
      allowed: true,
      code: 'ALLOW',
      reasons,
      effectiveRoles,
      membershipState: context.membershipState,
    };
  }

  explain(policy: AccessPolicy, context: RoleContext, effectiveRoles: Role[]): string {
    const decision = this.evaluate(policy, context, effectiveRoles);
    const status = decision.allowed ? 'ALLOWED' : 'DENIED';
    const paramsString = policy.params ? ` params=${JSON.stringify(policy.params)}` : '';
    const lines = [
      `${status} for ruleType=${this.type}${paramsString}`,
      `roles=[${effectiveRoles.join(', ')}]`,
      ...decision.reasons.map(r => `- ${r.code}: ${r.message}`),
    ];
    return lines.join('\n');
  }
}
