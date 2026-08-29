/**
 * A dependency-free, pure evaluator for compound boolean eligibility
 * rules. Operates only on structured data (a discriminated-union rule
 * tree) and a caller-supplied facts object - it never executes source
 * strings, `eval`, or `Function`.
 *
 * This module has no knowledge of memberships, Prisma models, Fastify
 * requests, Redis or any other infrastructure. It is a standalone
 * eligibility-rule evaluation primitive.
 */

// ---------------------------------------------------------------------------
// Rule types
// ---------------------------------------------------------------------------

/** Tests whether a fact field strictly equals a scalar value. */
export interface EqualsRule {
  readonly type: "equals";
  readonly field: string;
  readonly value: string | number | boolean;
}

/** Tests whether a fact field is present (not `undefined`). */
export interface ExistsRule {
  readonly type: "exists";
  readonly field: string;
}

/** Tests whether a fact field's value is contained in a fixed list. */
export interface InRule {
  readonly type: "in";
  readonly field: string;
  readonly values: ReadonlyArray<string | number>;
}

/** Tests whether a fact field is greater than or equal to a number. */
export interface GteRule {
  readonly type: "gte";
  readonly field: string;
  readonly value: number;
}

/** Tests whether a fact field is less than or equal to a number. */
export interface LteRule {
  readonly type: "lte";
  readonly field: string;
  readonly value: number;
}

/** Requires every child rule to pass. Vacuously true when empty. */
export interface AllRule {
  readonly type: "all";
  readonly children: readonly EligibilityRule[];
}

/** Requires at least one child rule to pass. Vacuously false when empty. */
export interface AnyRule {
  readonly type: "any";
  readonly children: readonly EligibilityRule[];
}

/** Inverts the result of a single child rule. */
export interface NotRule {
  readonly type: "not";
  readonly child: EligibilityRule;
}

export type EligibilityRule =
  | EqualsRule
  | ExistsRule
  | InRule
  | GteRule
  | LteRule
  | AllRule
  | AnyRule
  | NotRule;

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * A flat or nested map of fact values supplied by the caller. Paths are
 * dot-separated (e.g. `"profile.age"`) and resolved safely; a missing
 * segment yields `undefined` without throwing.
 */
export type Facts = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Reasons a value was rejected during structural validation. */
export type EligibilityRuleErrorCode =
  | "NOT_AN_OBJECT"
  | "UNKNOWN_RULE_TYPE"
  | "INVALID_FIELD"
  | "INVALID_SCALAR_VALUE"
  | "INVALID_VALUES_ARRAY"
  | "INVALID_NUMERIC_VALUE"
  | "INVALID_CHILDREN"
  | "INVALID_CHILD"
  | "MAX_DEPTH_EXCEEDED"
  | "MAX_NODES_EXCEEDED";

/**
 * Thrown whenever a supplied rule is malformed or exceeds the configured
 * evaluation limits. `path` points at the offending node, described as a
 * sequence of property/index accessors from the root.
 */
export class EligibilityRuleError extends Error {
  public readonly code: EligibilityRuleErrorCode;
  public readonly path: ReadonlyArray<string | number>;

  constructor(
    code: EligibilityRuleErrorCode,
    message: string,
    path: ReadonlyArray<string | number>
  ) {
    super(`${message} (at ${path.length > 0 ? path.join(".") : "<root>"})`);
    this.name = "EligibilityRuleError";
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Limits enforced while validating an untrusted rule tree. */
export interface EligibilityRuleLimits {
  /** Maximum allowed nesting depth. A leaf node has depth 1. */
  readonly maxDepth: number;
  /** Maximum total number of nodes (leaves and operators combined). */
  readonly maxNodes: number;
}

export const DEFAULT_ELIGIBILITY_RULE_LIMITS: EligibilityRuleLimits = {
  maxDepth: 32,
  maxNodes: 500,
};

// ---------------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------------

const LEAF_TYPES = new Set(["equals", "exists", "in", "gte", "lte"]);
const COMPOSITE_TYPES = new Set(["all", "any"]);
const NODE_TYPES = new Set([...LEAF_TYPES, ...COMPOSITE_TYPES, "not"]);

/**
 * Validates untrusted input against the eligibility-rule grammar, enforcing
 * depth and node-count limits along the way. Throws
 * {@link EligibilityRuleError} on any malformed or oversized input; never
 * returns a partially-valid result.
 *
 * The node/depth counters are checked before recursing into children, so
 * pathological input (huge fan-out, deep or cyclic nesting) is rejected
 * with bounded work rather than exhausting memory or the call stack.
 */
export function parseEligibilityRule(
  input: unknown,
  limits: EligibilityRuleLimits = DEFAULT_ELIGIBILITY_RULE_LIMITS
): EligibilityRule {
  const nodeCount = { value: 0 };
  return parseNode(input, limits, nodeCount, 1, []);
}

function parseNode(
  input: unknown,
  limits: EligibilityRuleLimits,
  nodeCount: { value: number },
  depth: number,
  path: ReadonlyArray<string | number>
): EligibilityRule {
  if (depth > limits.maxDepth) {
    throw new EligibilityRuleError(
      "MAX_DEPTH_EXCEEDED",
      `rule exceeds maximum nesting depth of ${limits.maxDepth}`,
      path
    );
  }

  nodeCount.value += 1;
  if (nodeCount.value > limits.maxNodes) {
    throw new EligibilityRuleError(
      "MAX_NODES_EXCEEDED",
      `rule exceeds maximum node count of ${limits.maxNodes}`,
      path
    );
  }

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EligibilityRuleError(
      "NOT_AN_OBJECT",
      "rule node must be a non-null, non-array object",
      path
    );
  }

  const record = input as Record<string, unknown>;
  const type = record.type;

  if (typeof type !== "string" || !NODE_TYPES.has(type)) {
    throw new EligibilityRuleError(
      "UNKNOWN_RULE_TYPE",
      `node "type" must be one of: ${[...NODE_TYPES].join(", ")}`,
      path
    );
  }

  switch (type) {
    case "equals":
      return parseEqualsNode(record, path);
    case "exists":
      return parseExistsNode(record, path);
    case "in":
      return parseInNode(record, path);
    case "gte":
      return parseNumericRangeNode("gte", record, path);
    case "lte":
      return parseNumericRangeNode("lte", record, path);
    case "not":
      return parseNotNode(record, limits, nodeCount, depth, path);
    default:
      // "all" | "any"
      return parseCompositeNode(
        type as "all" | "any",
        record,
        limits,
        nodeCount,
        depth,
        path
      );
  }
}

function requireField(
  record: Record<string, unknown>,
  path: ReadonlyArray<string | number>
): string {
  const field = record.field;
  if (typeof field !== "string" || field.length === 0) {
    throw new EligibilityRuleError(
      "INVALID_FIELD",
      `rule requires a non-empty string "field"`,
      path
    );
  }
  return field;
}

function parseEqualsNode(
  record: Record<string, unknown>,
  path: ReadonlyArray<string | number>
): EqualsRule {
  const field = requireField(record, path);
  const value = record.value;
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new EligibilityRuleError(
      "INVALID_SCALAR_VALUE",
      `"equals" rule requires a string, number or boolean "value"`,
      path
    );
  }
  return { type: "equals", field, value };
}

function parseExistsNode(
  record: Record<string, unknown>,
  path: ReadonlyArray<string | number>
): ExistsRule {
  const field = requireField(record, path);
  return { type: "exists", field };
}

function parseInNode(
  record: Record<string, unknown>,
  path: ReadonlyArray<string | number>
): InRule {
  const field = requireField(record, path);
  const rawValues = record.values;
  if (!Array.isArray(rawValues)) {
    throw new EligibilityRuleError(
      "INVALID_VALUES_ARRAY",
      `"in" rule requires a "values" array`,
      path
    );
  }
  const values: Array<string | number> = [];
  for (let i = 0; i < rawValues.length; i += 1) {
    const item = rawValues[i];
    if (typeof item !== "string" && typeof item !== "number") {
      throw new EligibilityRuleError(
        "INVALID_VALUES_ARRAY",
        `"in" rule "values" array may only contain strings or numbers (index ${i} is invalid)`,
        [...path, "values", i]
      );
    }
    values.push(item);
  }
  return { type: "in", field, values };
}

function parseNumericRangeNode(
  type: "gte" | "lte",
  record: Record<string, unknown>,
  path: ReadonlyArray<string | number>
): GteRule | LteRule {
  const field = requireField(record, path);
  const value = record.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EligibilityRuleError(
      "INVALID_NUMERIC_VALUE",
      `"${type}" rule requires a finite numeric "value"`,
      path
    );
  }
  return { type, field, value };
}

function parseNotNode(
  record: Record<string, unknown>,
  limits: EligibilityRuleLimits,
  nodeCount: { value: number },
  depth: number,
  path: ReadonlyArray<string | number>
): NotRule {
  if (!("child" in record)) {
    throw new EligibilityRuleError(
      "INVALID_CHILD",
      `"not" rule requires a "child" property`,
      path
    );
  }
  const child = parseNode(
    record.child,
    limits,
    nodeCount,
    depth + 1,
    [...path, "child"]
  );
  return { type: "not", child };
}

function parseCompositeNode(
  type: "all" | "any",
  record: Record<string, unknown>,
  limits: EligibilityRuleLimits,
  nodeCount: { value: number },
  depth: number,
  path: ReadonlyArray<string | number>
): AllRule | AnyRule {
  const rawChildren = record.children;
  if (!Array.isArray(rawChildren)) {
    throw new EligibilityRuleError(
      "INVALID_CHILDREN",
      `"${type}" rule requires a "children" array`,
      path
    );
  }
  const children: EligibilityRule[] = [];
  for (let i = 0; i < rawChildren.length; i += 1) {
    children.push(
      parseNode(rawChildren[i], limits, nodeCount, depth + 1, [
        ...path,
        "children",
        i,
      ])
    );
  }
  return type === "all" ? { type: "all", children } : { type: "any", children };
}

// ---------------------------------------------------------------------------
// Fact resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a dot-separated field path against the facts object. Returns
 * `undefined` when any segment is missing, rather than throwing.
 *
 * Distinguishes explicitly missing fields from fields containing `null`
 * or `false` (those are present but have falsy values).
 */
function resolveFact(
  facts: Facts,
  field: string
): { found: true; value: unknown } | { found: false } {
  const segments = field.split(".");
  let current: unknown = facts;
  for (const segment of segments) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return { found: false };
    }
    const obj = current as Record<string, unknown>;
    if (!(segment in obj)) {
      return { found: false };
    }
    current = obj[segment];
  }
  return { found: true, value: current };
}

// ---------------------------------------------------------------------------
// Evaluation result
// ---------------------------------------------------------------------------

/** The reason(s) a rule evaluation produced a denial. */
export interface EligibilityDenialReason {
  /** The type of the leaf rule that produced this denial. */
  readonly ruleType: EligibilityRule["type"];
  /** The field name involved (absent for composite rules). */
  readonly field?: string;
  /** A human-readable, machine-stable denial description. */
  readonly reason: string;
}

export interface EligibilityResult {
  /** `true` when all required conditions are met. */
  readonly eligible: boolean;
  /**
   * Present only when `explain: true` was requested and `eligible` is
   * `false`. Lists the leaf rules responsible for the denial.
   */
  readonly denialReasons?: readonly EligibilityDenialReason[];
}

export interface EvaluateEligibilityRuleOptions {
  /** Structural limits enforced before evaluation. */
  readonly limits?: EligibilityRuleLimits;
  /**
   * When true and the result is a denial, `denialReasons` lists the leaf
   * rules responsible for the denial.
   */
  readonly explain?: boolean;
}

// ---------------------------------------------------------------------------
// Public evaluation entry point
// ---------------------------------------------------------------------------

/**
 * Evaluates an eligibility rule tree against a caller-supplied facts object.
 *
 * `rule` may be a pre-validated {@link EligibilityRule} or raw untrusted
 * input (e.g. deserialized from storage) - it is always re-validated via
 * {@link parseEligibilityRule} before evaluation, so malformed or
 * pathological input is rejected safely.
 *
 * Evaluation is pure and deterministic: no I/O, no randomness, no mutation
 * of inputs. All children are evaluated in full (no short-circuiting) so
 * `explain` results are complete rather than partial.
 */
export function evaluateEligibilityRule(
  rule: unknown,
  facts: Facts,
  options: EvaluateEligibilityRuleOptions = {}
): EligibilityResult {
  const validated = parseEligibilityRule(rule, options.limits);
  const eligible = evaluateNode(validated, facts);

  if (eligible || !options.explain) {
    return { eligible };
  }

  return {
    eligible: false,
    denialReasons: collectDenials(validated, facts),
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function evaluateNode(node: EligibilityRule, facts: Facts): boolean {
  switch (node.type) {
    case "equals": {
      const result = resolveFact(facts, node.field);
      if (!result.found) return false;
      return result.value === node.value;
    }

    case "exists": {
      const result = resolveFact(facts, node.field);
      return result.found;
    }

    case "in": {
      const result = resolveFact(facts, node.field);
      if (!result.found) return false;
      const v = result.value;
      if (typeof v !== "string" && typeof v !== "number") return false;
      return node.values.includes(v);
    }

    case "gte": {
      const result = resolveFact(facts, node.field);
      if (!result.found) return false;
      if (typeof result.value !== "number") return false;
      return result.value >= node.value;
    }

    case "lte": {
      const result = resolveFact(facts, node.field);
      if (!result.found) return false;
      if (typeof result.value !== "number") return false;
      return result.value <= node.value;
    }

    case "all":
      // Evaluate all children without short-circuiting to preserve
      // deterministic cost regardless of ordering.
      return node.children.reduce<boolean>(
        (acc, child) => evaluateNode(child, facts) && acc,
        true
      );

    case "any":
      return node.children.reduce<boolean>(
        (acc, child) => evaluateNode(child, facts) || acc,
        false
      );

    case "not":
      return !evaluateNode(node.child, facts);
  }
}

// ---------------------------------------------------------------------------
// Denial reason collection
// ---------------------------------------------------------------------------

function collectDenials(
  node: EligibilityRule,
  facts: Facts
): EligibilityDenialReason[] {
  if (evaluateNode(node, facts)) {
    // This subtree passed - it contributes no denials.
    return [];
  }

  switch (node.type) {
    case "equals": {
      const result = resolveFact(facts, node.field);
      const reason = result.found
        ? `field "${node.field}" equals ${JSON.stringify(result.value)}, expected ${JSON.stringify(node.value)}`
        : `field "${node.field}" is missing`;
      return [{ ruleType: "equals", field: node.field, reason }];
    }

    case "exists":
      return [
        {
          ruleType: "exists",
          field: node.field,
          reason: `field "${node.field}" is missing`,
        },
      ];

    case "in": {
      const result = resolveFact(facts, node.field);
      const reason = result.found
        ? `field "${node.field}" value ${JSON.stringify(result.value)} is not in [${node.values.map((v) => JSON.stringify(v)).join(", ")}]`
        : `field "${node.field}" is missing`;
      return [{ ruleType: "in", field: node.field, reason }];
    }

    case "gte": {
      const result = resolveFact(facts, node.field);
      const reason = result.found
        ? `field "${node.field}" value ${JSON.stringify(result.value)} is not >= ${node.value}`
        : `field "${node.field}" is missing`;
      return [{ ruleType: "gte", field: node.field, reason }];
    }

    case "lte": {
      const result = resolveFact(facts, node.field);
      const reason = result.found
        ? `field "${node.field}" value ${JSON.stringify(result.value)} is not <= ${node.value}`
        : `field "${node.field}" is missing`;
      return [{ ruleType: "lte", field: node.field, reason }];
    }

    case "all": {
      // "all" failed - collect reasons from every failing child.
      const reasons: EligibilityDenialReason[] = [];
      for (const child of node.children) {
        if (!evaluateNode(child, facts)) {
          reasons.push(...collectDenials(child, facts));
        }
      }
      return reasons;
    }

    case "any": {
      // "any" failed because every child failed - collect from all.
      const reasons: EligibilityDenialReason[] = [];
      for (const child of node.children) {
        reasons.push(...collectDenials(child, facts));
      }
      return reasons;
    }

    case "not": {
      // "not" failed because its child passed - report the child's truth.
      return collectTruths(node.child, facts);
    }
  }
}

/**
 * Collects denial reasons for a subtree that evaluated to `true`,
 * used when a `not` node fails (its child is true).
 */
function collectTruths(
  node: EligibilityRule,
  facts: Facts
): EligibilityDenialReason[] {
  if (!evaluateNode(node, facts)) {
    return [];
  }

  switch (node.type) {
    case "equals":
      return [
        {
          ruleType: "equals",
          field: node.field,
          reason: `field "${node.field}" equals forbidden value ${JSON.stringify(node.value)}`,
        },
      ];

    case "exists":
      return [
        {
          ruleType: "exists",
          field: node.field,
          reason: `field "${node.field}" is present but must be absent`,
        },
      ];

    case "in": {
      const result = resolveFact(facts, node.field);
      const displayValue = result.found ? JSON.stringify(result.value) : "unknown";
      return [
        {
          ruleType: "in",
          field: node.field,
          reason: `field "${node.field}" value ${displayValue} is in the disallowed list`,
        },
      ];
    }

    case "gte":
      return [
        {
          ruleType: "gte",
          field: node.field,
          reason: `field "${node.field}" satisfies the gte condition but is disallowed`,
        },
      ];

    case "lte":
      return [
        {
          ruleType: "lte",
          field: node.field,
          reason: `field "${node.field}" satisfies the lte condition but is disallowed`,
        },
      ];

    case "all": {
      const reasons: EligibilityDenialReason[] = [];
      for (const child of node.children) {
        reasons.push(...collectTruths(child, facts));
      }
      return reasons;
    }

    case "any": {
      // "any" passed because at least one child passed - report passing ones.
      const reasons: EligibilityDenialReason[] = [];
      for (const child of node.children) {
        if (evaluateNode(child, facts)) {
          reasons.push(...collectTruths(child, facts));
        }
      }
      return reasons;
    }

    case "not":
      // "not" passed because its child failed.
      return collectDenials(node.child, facts);
  }
}
