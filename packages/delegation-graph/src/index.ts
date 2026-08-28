export interface DelegationNode {
    id: string;
    initialWeight: bigint;
}

export interface DelegationEdge {
    from: string;
    to: string;
}

export interface EvaluationConfig {
    maxDepth?: number;
    maxNodes?: number;
}

export interface EvaluatedNode {
    id: string;
    totalWeight: bigint;
}

export class DelegationGraphError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DelegationGraphError';
    }
}

export function evaluateDelegationGraph(
    nodes: DelegationNode[],
    edges: DelegationEdge[],
    config?: EvaluationConfig
): EvaluatedNode[] {
    const maxDepth = config?.maxDepth ?? 100;
    const maxNodes = config?.maxNodes ?? 10000;

    if (nodes.length > maxNodes) {
        throw new DelegationGraphError(`Graph exceeds max nodes limit of ${maxNodes}`);
    }

    // Handle duplicates and map nodes
    const nodeMap = new Map<string, bigint>();
    for (const node of nodes) {
        if (nodeMap.has(node.id)) {
            // Depending on requirements, we can sum or error. Let's assume unique node IDs.
            throw new DelegationGraphError(`Duplicate node id: ${node.id}`);
        }
        nodeMap.set(node.id, node.initialWeight);
    }

    // Build adjacency list (from -> to)
    // Assuming standard 1:1 delegation (a user can only delegate to ONE person). 
    // Wait, the spec says "Handle duplicate edges cleanly".
    // If a user delegates to multiple? Typically in governance, 1 address can only have 1 delegate at a time.
    // If we support multiple edges from same user, do we split weight? "exact bigint math". Splitting is hard with bigints unless we do percentages.
    // Let's assume a node can have only ONE outgoing delegation edge. If multiple exist to the SAME target, it's a duplicate edge. If to DIFFERENT targets, maybe it's an error?
    // Let's implement standard "one delegate per address" first.
    const outDegree = new Map<string, string>();
    for (const edge of edges) {
        if (edge.from === edge.to) {
            throw new DelegationGraphError(`Self-delegation rejected for node: ${edge.from}`);
        }
        
        if (outDegree.has(edge.from)) {
            const existingTo = outDegree.get(edge.from);
            if (existingTo !== edge.to) {
                throw new DelegationGraphError(`Multiple different outgoing delegations for node: ${edge.from}`);
            }
            // If it's the same, it's a duplicate edge, handle cleanly (ignore)
        } else {
            outDegree.set(edge.from, edge.to);
        }
    }

    // Actually, maybe we can just build an in-degree map to resolve.
    // Since each node has at most 1 outgoing edge, the graph is a set of trees (directed towards the roots).
    // We can evaluate weights by topological sort or depth-first search with memoization.
    
    // Check for cycles using DFS
    const visited = new Set<string>();
    const stack = new Set<string>();
    const depths = new Map<string, number>();

    const checkCycleAndDepth = (nodeId: string, depth: number) => {
        if (depth > maxDepth) {
            throw new DelegationGraphError(`Max depth of ${maxDepth} exceeded at node: ${nodeId}`);
        }
        if (stack.has(nodeId)) {
            throw new DelegationGraphError(`Cycle detected involving node: ${nodeId}`);
        }
        if (visited.has(nodeId)) {
            return;
        }

        visited.add(nodeId);
        stack.add(nodeId);

        const target = outDegree.get(nodeId);
        if (target) {
            checkCycleAndDepth(target, depth + 1);
        }

        stack.delete(nodeId);
    };

    for (const nodeId of nodeMap.keys()) {
        if (!visited.has(nodeId)) {
            checkCycleAndDepth(nodeId, 0);
        }
    }

    // If no cycles, we can compute total weights
    const finalWeights = new Map<string, bigint>();
    // initialize with initial weights
    for (const [id, weight] of nodeMap.entries()) {
        finalWeights.set(id, weight);
    }

    // Since every node has out-degree <= 1, we can compute final weights.
    // Every node's weight ultimately flows to the root of its tree.
    // Let's accumulate weights.
    // For a node `u`, its weight goes to `target` (and so on until root).
    // Wait! Does a delegator KEEP their voting power? No, usually in delegation, the delegator gives their voting power to the delegate.
    // Wait, if A delegates to B, B gets A's weight + B's weight. A's effective voting weight becomes 0.
    // BUT maybe the problem expects the engine to return the final voting power of all nodes. 
    // Wait, the specification says "delegated weight is never counted more than once." 
    // And "multi-hop delegation resolution"
    // Let's clarify: if A -> B and B -> C, then A and B have 0, and C has A+B+C.
    // Let's compute this.

    const memo = new Map<string, string>(); // node -> root
    const findRoot = (node: string): string => {
        if (memo.has(node)) return memo.get(node)!;
        const target = outDegree.get(node);
        if (!target) {
            memo.set(node, node);
            return node;
        }
        const root = findRoot(target);
        memo.set(node, root);
        return root;
    };

    const finalResults = new Map<string, bigint>();
    // all nodes initially have 0 in final results, except if they are roots?
    // Let's initialize all to 0
    for (const id of nodeMap.keys()) {
        finalResults.set(id, 0n);
    }
    // Also need to handle nodes in edges that aren't in nodeMap (implicit nodes with 0 initial weight)
    for (const target of outDegree.values()) {
        if (!finalResults.has(target)) {
            finalResults.set(target, 0n);
        }
    }

    for (const [id, weight] of nodeMap.entries()) {
        const root = findRoot(id);
        const current = finalResults.get(root) || 0n;
        finalResults.set(root, current + weight);
    }

    const results: EvaluatedNode[] = [];
    for (const [id, totalWeight] of finalResults.entries()) {
        results.push({ id, totalWeight });
    }

    // Deterministic result ordering
    results.sort((a, b) => a.id.localeCompare(b.id));

    return results;
}
