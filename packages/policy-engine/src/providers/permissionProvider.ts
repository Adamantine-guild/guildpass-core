import type {
  EvaluationContext,
  EvaluationResult,
  RuleProvider,
} from '../types';

/**
 * Enforces granular permission requirements in addition to a policy's legacy
 * rule. DENY precedence makes missing permissions fail closed.
 */
export class PermissionProvider implements RuleProvider {
  name = 'PermissionProvider';
  priority = 300;

  evaluate(context: EvaluationContext): EvaluationResult {
    const required = context.policy.requiredPermissions;
    if (required === undefined) {
      return {
        result: 'ABSTAIN',
        explanation: 'Policy does not require granular permissions',
        code: 'PERMISSIONS_NOT_REQUIRED',
      };
    }

    if (!Array.isArray(required)) {
      return {
        result: 'DENY',
        explanation: 'requiredPermissions must be an array',
        code: 'MALFORMED_POLICY',
      };
    }
    if (required.length === 0) {
      return {
        result: 'ABSTAIN',
        explanation: 'Policy has no granular permission requirements',
        code: 'PERMISSIONS_NOT_REQUIRED',
      };
    }

    const invalid = required.filter(
      (permission) =>
        typeof permission !== 'string' ||
        !/^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)+$/.test(permission),
    );
    if (invalid.length > 0) {
      return {
        result: 'DENY',
        explanation: 'requiredPermissions contains an invalid permission name',
        code: 'MALFORMED_POLICY',
      };
    }

    const granted = new Set(context.effectivePermissions ?? []);
    const missing = required.filter((permission) => !granted.has(permission));
    if (missing.length > 0) {
      return {
        result: 'DENY',
        explanation: `Missing required permissions: ${missing.join(', ')}`,
        code: 'MISSING_REQUIRED_PERMISSIONS',
      };
    }

    return {
      result: 'ALLOW',
      explanation: `Required permissions granted: ${required.join(', ')}`,
      code: 'HAS_REQUIRED_PERMISSIONS',
    };
  }
}
