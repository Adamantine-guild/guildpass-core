/**
 * Constitutional Rule Engine - Schema & AST Validation
 */

import {
  ConstitutionalRule,
  ConstitutionalRuleSet,
  MutationType,
  ConstitutionalEffect,
} from './types';

const VALID_MUTATION_TYPES: Set<MutationType> = new Set([
  'ROLE_ASSIGNMENT',
  'ROLE_REVOCATION',
  'POLICY_UPDATE',
  'OVERRIDE_CREATE',
  'OVERRIDE_REVOKE',
  '*',
]);

const VALID_EFFECTS: Set<ConstitutionalEffect> = new Set([
  'ALLOW',
  'DENY',
  'REQUIRE_APPROVAL',
]);

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validate a single constitutional rule
 */
export function validateRule(rule: any): ValidationResult {
  const errors: ValidationError[] = [];

  if (!rule || typeof rule !== 'object') {
    return {
      valid: false,
      errors: [{ path: 'rule', message: 'Rule must be an object' }],
    };
  }

  if (!rule.id || typeof rule.id !== 'string') {
    errors.push({ path: 'id', message: 'Rule id must be a non-empty string' });
  }

  if (!rule.name || typeof rule.name !== 'string') {
    errors.push({ path: 'name', message: 'Rule name must be a non-empty string' });
  }

  if (!rule.targetAction || !VALID_MUTATION_TYPES.has(rule.targetAction)) {
    errors.push({
      path: 'targetAction',
      message: `Invalid targetAction "${rule.targetAction}". Must be one of: ${Array.from(VALID_MUTATION_TYPES).join(', ')}`,
    });
  }

  if (typeof rule.precedence !== 'number' || isNaN(rule.precedence)) {
    errors.push({ path: 'precedence', message: 'Precedence must be a valid number' });
  }

  if (!rule.effect || !VALID_EFFECTS.has(rule.effect)) {
    errors.push({
      path: 'effect',
      message: `Invalid effect "${rule.effect}". Must be one of: ${Array.from(VALID_EFFECTS).join(', ')}`,
    });
  }

  if (!rule.type || !['COOLDOWN', 'MULTI_ADMIN_APPROVAL', 'CUSTOM'].includes(rule.type)) {
    errors.push({
      path: 'type',
      message: 'Type must be one of: COOLDOWN, MULTI_ADMIN_APPROVAL, CUSTOM',
    });
  }

  if (!rule.params || typeof rule.params !== 'object') {
    errors.push({ path: 'params', message: 'Params must be an object' });
  } else {
    // Type-specific validations
    if (rule.type === 'COOLDOWN') {
      if (typeof rule.params.minIntervalSeconds !== 'number' || rule.params.minIntervalSeconds <= 0) {
        errors.push({
          path: 'params.minIntervalSeconds',
          message: 'Cooldown rule requires minIntervalSeconds to be a positive number',
        });
      }
    } else if (rule.type === 'MULTI_ADMIN_APPROVAL') {
      if (typeof rule.params.requiredApprovals !== 'number' || rule.params.requiredApprovals <= 0) {
        errors.push({
          path: 'params.requiredApprovals',
          message: 'MultiAdminApproval rule requires requiredApprovals to be a positive number',
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a constitutional rule set
 */
export function validateRuleSet(ruleSet: any): ValidationResult {
  const errors: ValidationError[] = [];

  if (!ruleSet || typeof ruleSet !== 'object') {
    return {
      valid: false,
      errors: [{ path: 'ruleSet', message: 'RuleSet must be an object' }],
    };
  }

  if (!ruleSet.communityId || typeof ruleSet.communityId !== 'string') {
    errors.push({ path: 'communityId', message: 'communityId must be a non-empty string' });
  }

  if (typeof ruleSet.version !== 'number' || ruleSet.version < 1) {
    errors.push({ path: 'version', message: 'version must be an integer >= 1' });
  }

  if (!Array.isArray(ruleSet.rules)) {
    errors.push({ path: 'rules', message: 'rules must be an array' });
  } else {
    ruleSet.rules.forEach((rule: any, index: number) => {
      const res = validateRule(rule);
      if (!res.valid) {
        res.errors.forEach((err) => {
          errors.push({
            path: `rules[${index}].${err.path}`,
            message: err.message,
          });
        });
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
