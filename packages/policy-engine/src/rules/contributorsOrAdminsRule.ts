import { AccessPolicy, RoleContext, Role, AccessDecision, DecisionReason } from '@guildpass/shared-types';
import { PolicyRulePlugin } from '../types';

export class ContributorsOrAdminsRule implements PolicyRulePlugin {
  readonly type = 'CONTRIBUTORS_OR_ADMINS';

  evaluate(policy: AccessPolicy, context: RoleContext, effectiveRoles: Role[]): AccessDecision {
    const reasons: DecisionReason[] = [
      {
        code: `MEMBERSHIP_${context.membershipState.toUpperCase()}`,
        message: `Membership is ${context.membershipState}`,
      },
    ];

    if (effectiveRoles.includes('admin') || effectiveRoles.includes('contributor')) {
      reasons.push({
        code: 'HAS_REQUIRED_ROLE',
        message: 'Contributor or admin grants access',
      });
      return {
        allowed: true,
        code: 'ALLOW',
        reasons,
        effectiveRoles,
        membershipState: context.membershipState,
      };
    }

    reasons.push({
      code: 'NEEDS_CONTRIBUTOR_OR_ADMIN',
      message: 'Contributor or admin required',
    });

    return {
      allowed: false,
      code: 'DENY',
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
