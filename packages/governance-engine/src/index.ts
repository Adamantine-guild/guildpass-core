/**
 * Constitutional Rule Engine
 *
 * A composable, JSON-based governance rule system that extends
 * the static policy engine with complex, multi-party conditional logic.
 *
 * Key Features:
 * - JSON-serializable rule ASTs (no executable code)
 * - Transparent evaluation traces
 * - Composable primitives and combinators
 * - Type-safe and validated at runtime
 * - Integration with existing policy engine
 */

// Export AST types
export * from './ast';

// Export validator
export * from './validator';

// Export context
export * from './context';

// Export evaluator
export * from './evaluator';

// Re-export relevant types from shared-types for convenience
export type { Role, MembershipState, RoleContext } from '@guildpass/shared-types';
