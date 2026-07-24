import type {
  RuleTree,
  RuleExprNode,
  RuleASTVersion,
} from "@guildpass/shared-types";

export interface ValidationOptions {
  maxDepth?: number;
  maxNodes?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_NODES = 50;

const VALID_PRIMITIVES = new Set([
  "HAS_ROLE",
  "HAS_ANY_ROLE",
  "HAS_MIN_ROLES",
  "ACTIVE_MEMBERSHIP",
  "MEMBERSHIP_DURATION",
  "HAS_OVERRIDE",
  "TIME_WINDOW",
  "ALWAYS_ALLOW",
  "ALWAYS_DENY",
]);

const VALID_COMBINATORS = new Set(["AND", "OR", "NOT"]);

/**
 * Validates a rule tree AST for structural correctness, bounding evaluation cost,
 * and ensuring sandboxed execution without arbitrary code execution risk.
 */
export function validateRuleTree(
  tree: unknown,
  options: ValidationOptions = {}
): ValidationResult {
  const errors: string[] = [];
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;

  if (!tree || typeof tree !== "object") {
    return { valid: false, errors: ["Rule tree must be a non-null object"] };
  }

  const obj = tree as Record<string, unknown>;

  if (!obj.version || (obj.version !== "1.0" && obj.version !== "1")) {
    errors.push("Rule tree must specify version '1.0' or '1'");
  }

  if (!obj.root || typeof obj.root !== "object") {
    errors.push("Rule tree must contain a valid root node object");
    return { valid: false, errors };
  }

  let nodeCount = 0;

  function checkNode(node: unknown, depth: number): void {
    nodeCount++;
    if (nodeCount > maxNodes) {
      errors.push(`Rule tree exceeds maximum allowed node limit of ${maxNodes}`);
      return;
    }

    if (depth > maxDepth) {
      errors.push(`Rule tree exceeds maximum nesting depth of ${maxDepth}`);
      return;
    }

    if (!node || typeof node !== "object") {
      errors.push(`Invalid node at depth ${depth}: must be an object`);
      return;
    }

    const n = node as Record<string, unknown>;
    const type = n.type;

    if (typeof type !== "string") {
      errors.push(`Node at depth ${depth} is missing string field 'type'`);
      return;
    }

    if (VALID_COMBINATORS.has(type)) {
      if (type === "AND" || type === "OR") {
        if (!Array.isArray(n.rules) || n.rules.length === 0) {
          errors.push(`Combinator '${type}' must have a non-empty 'rules' array`);
        } else {
          for (const child of n.rules) {
            checkNode(child, depth + 1);
          }
        }
      } else if (type === "NOT") {
        if (!n.rule || typeof n.rule !== "object") {
          errors.push(`Combinator 'NOT' must have a single 'rule' object`);
        } else {
          checkNode(n.rule, depth + 1);
        }
      }
      return;
    }

    if (VALID_PRIMITIVES.has(type)) {
      validatePrimitiveParams(type, n, depth);
      return;
    }

    errors.push(`Unknown or unsupported rule node type '${type}' at depth ${depth}`);
  }

  function validatePrimitiveParams(type: string, n: Record<string, unknown>, depth: number): void {
    switch (type) {
      case "HAS_ROLE":
        if (typeof n.role !== "string" || n.role.trim() === "") {
          errors.push(`Node 'HAS_ROLE' at depth ${depth} requires a non-empty string 'role'`);
        }
        break;

      case "HAS_ANY_ROLE":
        if (!Array.isArray(n.roles) || n.roles.length === 0 || !n.roles.every((r) => typeof r === "string" && r.trim() !== "")) {
          errors.push(`Node 'HAS_ANY_ROLE' at depth ${depth} requires a non-empty string array 'roles'`);
        }
        break;

      case "HAS_MIN_ROLES":
        if (!Array.isArray(n.roles) || n.roles.length === 0 || !n.roles.every((r) => typeof r === "string" && r.trim() !== "")) {
          errors.push(`Node 'HAS_MIN_ROLES' at depth ${depth} requires a non-empty string array 'roles'`);
        }
        if (typeof n.minCount !== "number" || n.minCount < 1) {
          errors.push(`Node 'HAS_MIN_ROLES' at depth ${depth} requires a positive integer 'minCount'`);
        }
        break;

      case "ACTIVE_MEMBERSHIP":
        // No required extra parameters
        break;

      case "MEMBERSHIP_DURATION":
        if (
          (n.minDays !== undefined && (typeof n.minDays !== "number" || n.minDays < 0)) ||
          (n.minHours !== undefined && (typeof n.minHours !== "number" || n.minHours < 0)) ||
          (n.minSeconds !== undefined && (typeof n.minSeconds !== "number" || n.minSeconds < 0))
        ) {
          errors.push(`Node 'MEMBERSHIP_DURATION' at depth ${depth} requires non-negative numbers for minDays, minHours, or minSeconds`);
        }
        if (n.minDays === undefined && n.minHours === undefined && n.minSeconds === undefined) {
          errors.push(`Node 'MEMBERSHIP_DURATION' at depth ${depth} must specify at least one of minDays, minHours, or minSeconds`);
        }
        break;

      case "HAS_OVERRIDE":
        if (n.effect !== undefined && n.effect !== "ALLOW" && n.effect !== "DENY") {
          errors.push(`Node 'HAS_OVERRIDE' at depth ${depth} effect must be 'ALLOW' or 'DENY'`);
        }
        break;

      case "TIME_WINDOW":
        if (n.daysOfWeek !== undefined) {
          if (!Array.isArray(n.daysOfWeek) || !n.daysOfWeek.every((d) => typeof d === "number" && d >= 0 && d <= 6)) {
            errors.push(`Node 'TIME_WINDOW' at depth ${depth} daysOfWeek must be an array of numbers between 0 (Sun) and 6 (Sat)`);
          }
        }
        if (n.startTime !== undefined && typeof n.startTime !== "string") {
          errors.push(`Node 'TIME_WINDOW' at depth ${depth} startTime must be a string`);
        }
        if (n.endTime !== undefined && typeof n.endTime !== "string") {
          errors.push(`Node 'TIME_WINDOW' at depth ${depth} endTime must be a string`);
        }
        break;

      case "ALWAYS_ALLOW":
      case "ALWAYS_DENY":
        break;
    }
  }

  checkNode(obj.root, 1);

  return {
    valid: errors.length === 0,
    errors,
  };
}

/** Pre-built Rule AST Templates for the 4 legacy static rules */
export const PUBLIC_RULE_TEMPLATE: RuleTree = {
  version: "1.0",
  name: "PUBLIC",
  description: "Public access open to everyone",
  root: {
    type: "ALWAYS_ALLOW",
  },
};

export const MEMBERS_ONLY_RULE_TEMPLATE: RuleTree = {
  version: "1.0",
  name: "MEMBERS_ONLY",
  description: "Access restricted to active community members",
  root: {
    type: "ACTIVE_MEMBERSHIP",
  },
};

export const ADMINS_ONLY_RULE_TEMPLATE: RuleTree = {
  version: "1.0",
  name: "ADMINS_ONLY",
  description: "Access restricted to users with admin role",
  root: {
    type: "AND",
    rules: [
      { type: "ACTIVE_MEMBERSHIP" },
      { type: "HAS_ROLE", role: "admin" },
    ],
  },
};

export const CONTRIBUTORS_OR_ADMINS_RULE_TEMPLATE: RuleTree = {
  version: "1.0",
  name: "CONTRIBUTORS_OR_ADMINS",
  description: "Access restricted to contributors or admins",
  root: {
    type: "AND",
    rules: [
      { type: "ACTIVE_MEMBERSHIP" },
      {
        type: "HAS_ANY_ROLE",
        roles: ["admin", "contributor"],
      },
    ],
  },
};

export function getLegacyRuleTemplate(ruleType: string): RuleTree | null {
  switch (ruleType) {
    case "PUBLIC":
      return PUBLIC_RULE_TEMPLATE;
    case "MEMBERS_ONLY":
      return MEMBERS_ONLY_RULE_TEMPLATE;
    case "ADMINS_ONLY":
      return ADMINS_ONLY_RULE_TEMPLATE;
    case "CONTRIBUTORS_OR_ADMINS":
      return CONTRIBUTORS_OR_ADMINS_RULE_TEMPLATE;
    default:
      return null;
  }
}
