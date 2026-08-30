/**
 * Policy Explanation Engine
 * 
 * A standalone, side-effect-free engine for explaining policy evaluation decisions.
 * Accepts a tree of evaluated policy conditions and produces deterministic,
 * structured explanations suitable for logs, tests, and access decisions.
 */

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * A node in the evaluation tree representing a policy condition or logical operation.
 */
export type EvaluationNode =
  | ConditionNode
  | AllNode
  | AnyNode
  | NotNode;

/**
 * A leaf node representing a single condition evaluation.
 */
export interface ConditionNode {
  type: "condition";
  id: string;
  passed: boolean;
  reason?: string;
}

/**
 * A logical AND node - all children must pass.
 */
export interface AllNode {
  type: "all";
  children: EvaluationNode[];
}

/**
 * A logical OR node - at least one child must pass.
 */
export interface AnyNode {
  type: "any";
  children: EvaluationNode[];
}

/**
 * A logical NOT node - inverts the child's result.
 */
export interface NotNode {
  type: "not";
  child: EvaluationNode;
}

/**
 * A reason explaining a policy decision.
 */
export interface DecisionReason {
  code: string;
  nodeId: string;
  message?: string;
}

/**
 * The complete explanation of a policy decision.
 */
export interface DecisionExplanation {
  allowed: boolean;
  reasons: DecisionReason[];
}

/**
 * Configuration options for the explanation engine.
 */
export interface ExplanationOptions {
  /**
   * Maximum allowed depth of the evaluation tree.
   * @default 50
   */
  maxDepth?: number;
  
  /**
   * Maximum allowed number of nodes in the evaluation tree.
   * @default 1000
   */
  maxNodes?: number;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error thrown when the evaluation tree is malformed or exceeds limits.
 */
export class ExplanationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplanationError";
  }
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_MAX_DEPTH = 50;
const DEFAULT_MAX_NODES = 1000;

// ============================================================================
// Reason Code Generation
// ============================================================================

/**
 * Generates stable reason codes based on node type and outcome.
 */
function generateReasonCode(nodeType: string, passed: boolean): string {
  const prefix = passed ? "PASS" : "FAIL";
  const typeMap: Record<string, string> = {
    condition: "COND",
    all: "ALL",
    any: "ANY",
    not: "NOT"
  };
  return `${prefix}_${typeMap[nodeType] || nodeType.toUpperCase()}`;
}

// ============================================================================
// Tree Validation
// ============================================================================

/**
 * Validates the evaluation tree structure and limits.
 */
function validateTree(
  node: EvaluationNode,
  depth: number,
  nodeCount: { value: number },
  options: Required<ExplanationOptions>
): void {
  const maxDepth = options.maxDepth;
  const maxNodes = options.maxNodes;

  if (depth >= maxDepth) {
    throw new ExplanationError(
      `Evaluation tree exceeds maximum depth of ${maxDepth}`
    );
  }

  nodeCount.value++;
  if (nodeCount.value > maxNodes) {
    throw new ExplanationError(
      `Evaluation tree exceeds maximum node count of ${maxNodes}`
    );
  }

  switch (node.type) {
    case "condition":
      if (typeof node.id !== "string" || node.id.length === 0) {
        throw new ExplanationError("Condition node must have a non-empty id");
      }
      if (typeof node.passed !== "boolean") {
        throw new ExplanationError("Condition node must have a boolean passed field");
      }
      break;

    case "all":
    case "any":
      if (!Array.isArray(node.children)) {
        throw new ExplanationError(
          `${node.type} node must have a children array`
        );
      }
      for (const child of node.children) {
        validateTree(child, depth + 1, nodeCount, options);
      }
      break;

    case "not":
      if (!node.child) {
        throw new ExplanationError("Not node must have a child");
      }
      validateTree(node.child, depth + 1, nodeCount, options);
      break;

    default:
      throw new ExplanationError(
        `Unknown node type: ${(node as { type: string }).type}`
      );
  }
}

// ============================================================================
// Outcome Calculation
// ============================================================================

/**
 * Calculates the boolean outcome of an evaluation node.
 */
function calculateOutcome(node: EvaluationNode): boolean {
  switch (node.type) {
    case "condition":
      return node.passed;

    case "all":
      return node.children.every((child) => calculateOutcome(child));

    case "any":
      return node.children.some((child) => calculateOutcome(child));

    case "not":
      return !calculateOutcome(node.child);
  }
}

// ============================================================================
// Reason Extraction
// ============================================================================

/**
 * Extracts reasons from an evaluation tree.
 * For failures, focuses on the most relevant failing conditions.
 */
function extractReasons(
  node: EvaluationNode,
  parentPassed: boolean | null,
  reasons: DecisionReason[],
  path: string[]
): void {
  const nodeId = isConditionNode(node) ? node.id : path.join(".");
  const outcome = calculateOutcome(node);

  switch (node.type) {
    case "condition": {
      const code = generateReasonCode("condition", outcome);
      reasons.push({
        code,
        nodeId,
        message: node.reason
      });
      break;
    }

    case "all": {
      if (!outcome) {
        // For ALL failures, report all failing children
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          const childOutcome = calculateOutcome(child);
          if (!childOutcome) {
            extractReasons(child, false, reasons, [...path, String(i)]);
          }
        }
      } else {
        // For ALL passes, report that all children passed
        reasons.push({
          code: generateReasonCode("all", true),
          nodeId,
          message: "All conditions passed"
        });
      }
      break;
    }

    case "any": {
      if (!outcome) {
        // For ANY failures, report that no child passed and show child reasons
        reasons.push({
          code: generateReasonCode("any", false),
          nodeId,
          message: "No conditions passed"
        });
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          extractReasons(child, false, reasons, [...path, String(i)]);
        }
      } else {
        // For ANY passes, report the passing child
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          if (calculateOutcome(child)) {
            extractReasons(child, true, reasons, [...path, String(i)]);
            break; // Only report the first passing child
          }
        }
      }
      break;
    }

    case "not": {
      const childOutcome = calculateOutcome(node.child);
      reasons.push({
        code: generateReasonCode("not", outcome),
        nodeId,
        message: outcome
          ? "Negated condition failed"
          : "Negated condition passed"
      });
      // Always include child details for NOT nodes for clarity
      extractReasons(node.child, outcome, reasons, [...path, "0"]);
      break;
    }
  }
}

// ============================================================================
// Main Explanation Function
// ============================================================================

/**
 * Explains a policy decision based on an evaluation tree.
 * 
 * @param node - The root of the evaluation tree
 * @param options - Configuration options
 * @returns A structured decision explanation
 * @throws {ExplanationError} If the tree is malformed or exceeds limits
 */
export function explainDecision(
  node: EvaluationNode,
  options: ExplanationOptions = {}
): DecisionExplanation {
  const resolvedOptions: Required<ExplanationOptions> = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES
  };

  // Validate the tree structure and limits
  const nodeCount = { value: 0 };
  validateTree(node, 0, nodeCount, resolvedOptions);

  // Calculate the overall outcome
  const allowed = calculateOutcome(node);

  // Extract reasons
  const reasons: DecisionReason[] = [];
  extractReasons(node, null, reasons, []);

  // Ensure deterministic ordering by sorting reasons
  // For NOT nodes, ensure the NOT reason comes before child reason
  reasons.sort((a, b) => {
    // Prioritize NOT codes over COND codes when codes are different
    if (a.code.includes('NOT') && !b.code.includes('NOT')) {
      return -1;
    }
    if (!a.code.includes('NOT') && b.code.includes('NOT')) {
      return 1;
    }
    // Sort by code first, then by nodeId
    if (a.code !== b.code) {
      return a.code.localeCompare(b.code);
    }
    return a.nodeId.localeCompare(b.nodeId);
  });

  return {
    allowed,
    reasons
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Creates a condition node.
 */
export function condition(
  id: string,
  passed: boolean,
  reason?: string
): ConditionNode {
  return { type: "condition", id, passed, reason };
}

/**
 * Creates an ALL node (logical AND).
 */
export function all(...children: EvaluationNode[]): AllNode {
  return { type: "all", children };
}

/**
 * Creates an ANY node (logical OR).
 */
export function any(...children: EvaluationNode[]): AnyNode {
  return { type: "any", children };
}

/**
 * Creates a NOT node (logical negation).
 */
export function not(child: EvaluationNode): NotNode {
  return { type: "not", child };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for condition nodes.
 */
export function isConditionNode(node: EvaluationNode): node is ConditionNode {
  return node.type === "condition";
}

/**
 * Type guard for ALL nodes.
 */
export function isAllNode(node: EvaluationNode): node is AllNode {
  return node.type === "all";
}

/**
 * Type guard for ANY nodes.
 */
export function isAnyNode(node: EvaluationNode): node is AnyNode {
  return node.type === "any";
}

/**
 * Type guard for NOT nodes.
 */
export function isNotNode(node: EvaluationNode): node is NotNode {
  return node.type === "not";
}
