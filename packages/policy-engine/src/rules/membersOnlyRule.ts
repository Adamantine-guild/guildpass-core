import { AccessPolicy, RoleContext, Role, AccessDecision, DecisionReason } from '@guildpass/shared-types';
import { PolicyRulePlugin } from '../types';

export class MembersOnlyRule implements PolicyRulePlugin {
  readonly type = 'MEMBERS_ONLY';

  evaluate(policy: AccessPolicy, context: RoleContext, effectiveRoles: Role[]): AccessDecision {
    const reasons: DecisionReason[] = [
      {
        code: `MEMBERSHIP_${context.membershipState.toUpperCase()}`,
        message: `Membership is ${context.membershipState}`,
      },
    ];

    if (context.membershipState !== 'active') {
      reasons.push({
        code: 'NEEDS_ACTIVE',
        message: 'Requires active membership',
      });
      return {
        allowed: false,
        code: 'DENY',
        reasons,
        effectiveRoles,
        membershipState: context.membershipState,
      };
    }

    reasons.push({
      code: 'HAS_ACTIVE_MEMBERSHIP',
      message: 'Active membership grants access',
    });

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
