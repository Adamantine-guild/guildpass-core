/**
 * A dependency-free, pure evaluator for compound boolean permission
 * expressions. Operates only on structured data (a discriminated-union
 * AST) - it never executes source strings, `eval`, or `Function`.
 *
 * This module has no knowledge of memberships, Prisma models, Fastify
 * requests or Redis. It is a standalone rule-evaluation primitive.
 */

/** A single required permission, e.g. "community.manage". */
export interface PermissionLeaf {
  readonly type: "permission";
  readonly value: string;
}

/** Requires every child expression to pass. Vacuously true when empty. */
export interface AllExpression {
  readonly type: "all";
  readonly children: readonly PermissionExpression[];
}

/** Requires at least one child expression to pass. Vacuously false when empty. */
export interface AnyExpression {
  readonly type: "any";
  readonly children: readonly PermissionExpression[];
}

/** Inverts the result of a single child expression. */
export interface NotExpression {
  readonly type: "not";
  readonly child: PermissionExpression;
}

export type PermissionExpression =
  | PermissionLeaf
  | AllExpression
  | AnyExpression
  | NotExpression;

const NODE_TYPES = new Set(["permission", "all", "any", "not"]);

/** Reasons a value was rejected during structural validation. */
export type PermissionExpressionErrorCode =
  | "NOT_AN_OBJECT"
  | "UNKNOWN_NODE_TYPE"
  | "INVALID_PERMISSION_VALUE"
  | "INVALID_CHILDREN"
  | "INVALID_CHILD"
  | "MAX_DEPTH_EXCEEDED"
  | "MAX_NODES_EXCEEDED";

/**
 * Thrown whenever a supplied expression is malformed or exceeds the
 * configured evaluation limits. `path` points at the offending node,
 * described as a sequence of property/index accessors from the root.
 */
export class PermissionExpressionError extends Error {
  public readonly code: PermissionExpressionErrorCode;
  public readonly path: ReadonlyArray<string | number>;

  constructor(
    code: PermissionExpressionErrorCode,
    message: string,
    path: ReadonlyArray<string | number>
  ) {
    super(`${message} (at ${path.length > 0 ? path.join(".") : "<root>"})`);
    this.name = "PermissionExpressionError";
    this.code = code;
    this.path = path;
  }
}

/** Limits enforced while validating an untrusted expression. */
export interface PermissionExpressionLimits {
  /** Maximum allowed nesting depth. A leaf node has depth 1. */
  readonly maxDepth: number;
  /** Maximum total number of nodes (leaves and operators combined). */
  readonly maxNodes: number;
}

export const DEFAULT_PERMISSION_EXPRESSION_LIMITS: PermissionExpressionLimits =
  {
    maxDepth: 32,
    maxNodes: 500,
  };

/**
 * Validates untrusted input against the permission-expression grammar,
 * enforcing depth and node-count limits along the way. Throws
 * {@link PermissionExpressionError} on any malformed or oversized input;
 * never returns a partially-valid result.
 *
 * The node/depth counters are checked before recursing into children, so
 * pathological input (huge fan-out, deep or cyclic nesting) is rejected
 * with bounded work rather than exhausting memory or the call stack.
 */
export function parsePermissionExpression(
  input: unknown,
  limits: PermissionExpressionLimits = DEFAULT_PERMISSION_EXPRESSION_LIMITS
): PermissionExpression {
  const nodeCount = { value: 0 };
  return parseNode(input, limits, nodeCount, 1, []);
}

function parseNode(
  input: unknown,
  limits: PermissionExpressionLimits,
  nodeCount: { value: number },
  depth: number,
  path: ReadonlyArray<string | number>
): PermissionExpression {
  if (depth > limits.maxDepth) {
    throw new PermissionExpressionError(
      "MAX_DEPTH_EXCEEDED",
      `expression exceeds maximum nesting depth of ${limits.maxDepth}`,
      path
    );
  }

  nodeCount.value += 1;
  if (nodeCount.value > limits.maxNodes) {
    throw new PermissionExpressionError(
      "MAX_NODES_EXCEEDED",
      `expression exceeds maximum node count of ${limits.maxNodes}`,
      path
    );
  }

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PermissionExpressionError(
      "NOT_AN_OBJECT",
      "expression node must be a non-null, non-array object",
      path
    );
  }

  const record = input as Record<string, unknown>;
  const type = record.type;

  if (typeof type !== "string" || !NODE_TYPES.has(type)) {
    throw new PermissionExpressionError(
      "UNKNOWN_NODE_TYPE",
      `node "type" must be one of "permission", "all", "any", "not"`,
      path
    );
  }

  if (type === "permission") {
    const value = record.value;
    if (typeof value !== "string" || value.length === 0) {
      throw new PermissionExpressionError(
        "INVALID_PERMISSION_VALUE",
        `"permission" node requires a non-empty string "value"`,
        path
      );
    }
    return { type: "permission", value };
  }

  if (type === "not") {
    const child = parseNode(
      record.child,
      limits,
      nodeCount,
      depth + 1,
      [...path, "child"]
    );
    return { type: "not", child };
  }

  // "all" or "any"
  const rawChildren = record.children;
  if (!Array.isArray(rawChildren)) {
    throw new PermissionExpressionError(
      "INVALID_CHILDREN",
      `"${type}" node requires a "children" array`,
      path
    );
  }

  const children: PermissionExpression[] = [];
  for (let index = 0; index < rawChildren.length; index += 1) {
    children.push(
      parseNode(rawChildren[index], limits, nodeCount, depth + 1, [
        ...path,
        "children",
        index,
      ])
    );
  }

  return type === "all"
    ? { type: "all", children }
    : { type: "any", children };
}

/** The set of permission strings granted to the caller being checked. */
export type GrantedPermissions = ReadonlySet<string> | Iterable<string>;

function toGrantedSet(granted: GrantedPermissions): ReadonlySet<string> {
  return granted instanceof Set ? granted : new Set(granted);
}

export interface EvaluatePermissionExpressionOptions {
  /** Structural limits enforced before evaluation. */
  readonly limits?: PermissionExpressionLimits;
  /**
   * When true and the result is a denial, `deniedLeaves` lists the leaf
   * nodes responsible for the denial.
   */
  readonly explain?: boolean;
}

export interface PermissionExpressionResult {
  readonly granted: boolean;
  /**
   * Present only when `explain: true` was requested and `granted` is
   * false. Lists the leaves whose absence (or, under `not`, presence)
   * caused the overall denial.
   */
  readonly deniedLeaves?: readonly PermissionLeaf[];
}

/**
 * Evaluates a permission expression against a set of granted permissions.
 *
 * `expression` may be a pre-validated {@link PermissionExpression} or raw
 * untrusted input (e.g. deserialized from storage) - it is always
 * re-validated via {@link parsePermissionExpression} before evaluation, so
 * malformed or pathological input is rejected safely rather than evaluated.
 *
 * Evaluation is pure and deterministic: no I/O, no randomness, no mutation
 * of inputs. Children are always evaluated in full (no short-circuiting),
 * so `explain` results are complete rather than partial.
 */
export function evaluatePermissionExpression(
  expression: unknown,
  granted: GrantedPermissions,
  options: EvaluatePermissionExpressionOptions = {}
): PermissionExpressionResult {
  const validated = parsePermissionExpression(expression, options.limits);
  const grantedSet = toGrantedSet(granted);
  const isGranted = evaluateNode(validated, grantedSet);

  if (isGranted || !options.explain) {
    return { granted: isGranted };
  }

  return { granted: false, deniedLeaves: reasonsNodeIsFalse(validated, grantedSet) };
}

function evaluateNode(
  node: PermissionExpression,
  granted: ReadonlySet<string>
): boolean {
  switch (node.type) {
    case "permission":
      return granted.has(node.value);
    case "all":
      // Reduce (not .every, which short-circuits) so evaluation always
      // touches every node - keeping cost/behavior predictable regardless
      // of ordering, and matching the non-short-circuiting explain pass.
      return node.children.reduce<boolean>(
        (acc, child) => evaluateNode(child, granted) && acc,
        true
      );
    case "any":
      return node.children.reduce<boolean>(
        (acc, child) => evaluateNode(child, granted) || acc,
        false
      );
    case "not":
      return !evaluateNode(node.child, granted);
  }
}

/** Leaves responsible for `node` evaluating to `false`. */
function reasonsNodeIsFalse(
  node: PermissionExpression,
  granted: ReadonlySet<string>
): PermissionLeaf[] {
  switch (node.type) {
    case "permission":
      return granted.has(node.value) ? [] : [node];
    case "all": {
      // "all" is false because at least one child was false; collect
      // reasons from every failing child.
      const reasons: PermissionLeaf[] = [];
      for (const child of node.children) {
        if (!evaluateNode(child, granted)) {
          reasons.push(...reasonsNodeIsFalse(child, granted));
        }
      }
      return reasons;
    }
    case "any": {
      // "any" is false only when every child is false; collect reasons
      // from all of them, since each contributed to the denial.
      const reasons: PermissionLeaf[] = [];
      for (const child of node.children) {
        reasons.push(...reasonsNodeIsFalse(child, granted));
      }
      return reasons;
    }
    case "not":
      // "not" is false because its child is true; the leaves "responsible"
      // are the ones that made the child true.
      return reasonsNodeIsTrue(node.child, granted);
  }
}

/** Leaves responsible for `node` evaluating to `true`. */
function reasonsNodeIsTrue(
  node: PermissionExpression,
  granted: ReadonlySet<string>
): PermissionLeaf[] {
  switch (node.type) {
    case "permission":
      return granted.has(node.value) ? [node] : [];
    case "all": {
      // "all" is true only when every child is true; every child
      // contributed.
      const reasons: PermissionLeaf[] = [];
      for (const child of node.children) {
        reasons.push(...reasonsNodeIsTrue(child, granted));
      }
      return reasons;
    }
    case "any": {
      // "any" is true because at least one child was true; collect
      // reasons from the passing children only.
      const reasons: PermissionLeaf[] = [];
      for (const child of node.children) {
        if (evaluateNode(child, granted)) {
          reasons.push(...reasonsNodeIsTrue(child, granted));
        }
      }
      return reasons;
    }
    case "not":
      return reasonsNodeIsFalse(node.child, granted);
  }
}
