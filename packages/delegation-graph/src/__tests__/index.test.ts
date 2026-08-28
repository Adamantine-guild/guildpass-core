import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import {
    evaluateDelegationGraph,
    DelegationNode,
    DelegationEdge,
    DelegationGraphError
} from '../index.js';

describe('Delegation Graph Evaluator', () => {
    test('should resolve simple one-hop delegation', () => {
        const nodes: DelegationNode[] = [
            { id: 'A', initialWeight: 100n },
            { id: 'B', initialWeight: 50n }
        ];
        const edges: DelegationEdge[] = [
            { from: 'A', to: 'B' }
        ];

        const results = evaluateDelegationGraph(nodes, edges);
        assert.deepStrictEqual(results, [
            { id: 'A', totalWeight: 0n },
            { id: 'B', totalWeight: 150n }
        ]);
    });

    test('should resolve multi-hop delegation', () => {
        const nodes: DelegationNode[] = [
            { id: 'A', initialWeight: 10n },
            { id: 'B', initialWeight: 20n },
            { id: 'C', initialWeight: 30n }
        ];
        const edges: DelegationEdge[] = [
            { from: 'A', to: 'B' },
            { from: 'B', to: 'C' }
        ];

        const results = evaluateDelegationGraph(nodes, edges);
        assert.deepStrictEqual(results, [
            { id: 'A', totalWeight: 0n },
            { id: 'B', totalWeight: 0n },
            { id: 'C', totalWeight: 60n }
        ]);
    });

    test('should handle branches (multiple delegators to one delegate)', () => {
        const nodes: DelegationNode[] = [
            { id: 'A', initialWeight: 10n },
            { id: 'B', initialWeight: 20n },
            { id: 'C', initialWeight: 30n }
        ];
        const edges: DelegationEdge[] = [
            { from: 'A', to: 'C' },
            { from: 'B', to: 'C' }
        ];

        const results = evaluateDelegationGraph(nodes, edges);
        assert.deepStrictEqual(results, [
            { id: 'A', totalWeight: 0n },
            { id: 'B', totalWeight: 0n },
            { id: 'C', totalWeight: 60n }
        ]);
    });

    test('should detect and reject cycles', () => {
        const nodes: DelegationNode[] = [
            { id: 'A', initialWeight: 10n },
            { id: 'B', initialWeight: 20n },
            { id: 'C', initialWeight: 30n }
        ];
        const edges: DelegationEdge[] = [
            { from: 'A', to: 'B' },
            { from: 'B', to: 'C' },
            { from: 'C', to: 'A' } // Cycle
        ];

        assert.throws(() => {
            evaluateDelegationGraph(nodes, edges);
        }, (err: any) => {
            return err instanceof DelegationGraphError && err.message.includes('Cycle detected');
        });
    });

    test('should reject self-delegation', () => {
        const nodes: DelegationNode[] = [
            { id: 'A', initialWeight: 10n }
        ];
        const edges: DelegationEdge[] = [
            { from: 'A', to: 'A' }
        ];

        assert.throws(() => {
            evaluateDelegationGraph(nodes, edges);
        }, (err: any) => {
            return err instanceof DelegationGraphError && err.message.includes('Self-delegation rejected');
        });
    });

    test('should enforce max depth limit', () => {
        const nodes: DelegationNode[] = [
            { id: 'A', initialWeight: 10n },
            { id: 'B', initialWeight: 20n },
            { id: 'C', initialWeight: 30n }
        ];
        const edges: DelegationEdge[] = [
            { from: 'A', to: 'B' },
            { from: 'B', to: 'C' }
        ];

        assert.throws(() => {
            evaluateDelegationGraph(nodes, edges, { maxDepth: 1 });
        }, (err: any) => {
            return err instanceof DelegationGraphError && err.message.includes('Max depth of 1 exceeded');
        });
    });

    test('should handle duplicate edges cleanly', () => {
        const nodes: DelegationNode[] = [
            { id: 'A', initialWeight: 10n },
            { id: 'B', initialWeight: 20n }
        ];
        const edges: DelegationEdge[] = [
            { from: 'A', to: 'B' },
            { from: 'A', to: 'B' } // Duplicate
        ];

        const results = evaluateDelegationGraph(nodes, edges);
        assert.deepStrictEqual(results, [
            { id: 'A', totalWeight: 0n },
            { id: 'B', totalWeight: 30n }
        ]);
    });

    test('should reject multiple different outgoing edges', () => {
        const nodes: DelegationNode[] = [
            { id: 'A', initialWeight: 10n },
            { id: 'B', initialWeight: 20n },
            { id: 'C', initialWeight: 30n }
        ];
        const edges: DelegationEdge[] = [
            { from: 'A', to: 'B' },
            { from: 'A', to: 'C' }
        ];

        assert.throws(() => {
            evaluateDelegationGraph(nodes, edges);
        }, (err: any) => {
            return err instanceof DelegationGraphError && err.message.includes('Multiple different outgoing');
        });
    });

    test('should handle disconnected participants', () => {
        const nodes: DelegationNode[] = [
            { id: 'A', initialWeight: 10n },
            { id: 'B', initialWeight: 20n },
            { id: 'C', initialWeight: 30n }
        ];
        const edges: DelegationEdge[] = [
            { from: 'A', to: 'B' }
        ]; // C is disconnected

        const results = evaluateDelegationGraph(nodes, edges);
        assert.deepStrictEqual(results, [
            { id: 'A', totalWeight: 0n },
            { id: 'B', totalWeight: 30n },
            { id: 'C', totalWeight: 30n }
        ]);
    });

    test('should enforce max nodes limit', () => {
        const nodes: DelegationNode[] = [
            { id: 'A', initialWeight: 10n },
            { id: 'B', initialWeight: 20n }
        ];
        const edges: DelegationEdge[] = [];

        assert.throws(() => {
            evaluateDelegationGraph(nodes, edges, { maxNodes: 1 });
        }, (err: any) => {
            return err instanceof DelegationGraphError && err.message.includes('Graph exceeds max nodes limit');
        });
    });

    test('should correctly aggregate implicit nodes not in nodeMap but present in edges', () => {
        const nodes: DelegationNode[] = [
            { id: 'A', initialWeight: 10n }
        ];
        const edges: DelegationEdge[] = [
            { from: 'A', to: 'B' }
        ];

        const results = evaluateDelegationGraph(nodes, edges);
        assert.deepStrictEqual(results, [
            { id: 'A', totalWeight: 0n },
            { id: 'B', totalWeight: 10n }
        ]);
    });
});
