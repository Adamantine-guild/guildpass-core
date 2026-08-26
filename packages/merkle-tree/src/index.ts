/**
 * Deterministic Merkle tree utility for GuildPass.
 *
 * This module is an isolated cryptographic primitive. It has no dependency on
 * membership services, Stellar RPC, Soroban, or any database.
 *
 * ## Specification
 *
 * Hash algorithm:
 *   All hashing uses SHA-256 (`node:crypto` `createHash('sha256')`).
 *   Every internal node and every canonical leaf hash is exactly 32 bytes.
 *
 * Leaf encoding:
 *   - By default (`prehashed: false`, the default), each caller-supplied leaf
 *     is an arbitrary byte string and its canonical hash is
 *     `SHA-256(leafBytes)`. Callers never need to pre-hash.
 *   - With `prehashed: true`, each leaf must already be exactly a 32-byte
 *     SHA-256 digest and is used verbatim as the leaf hash.
 *
 * Ordering:
 *   Caller order is preserved. Leaves are NOT sorted. The same ordered input
 *   always produces the same root; different orders produce different roots.
 *
 * Pair ordering:
 *   Within each level, nodes are paired strictly left to right in array order:
 *   `parent = SHA-256(left || right)`.
 *
 * Odd-node behaviour:
 *   When a level contains an odd number of nodes, the final unpaired node is
 *   duplicated with itself: `parent = SHA-256(node || node)`. This is applied
 *   deterministically at every level until a single root remains.
 *
 * Single-leaf trees:
 *   A tree with exactly one leaf has `root === leafHash`; no pairing occurs
 *   and the proof for that leaf is empty.
 *
 * Empty trees:
 *   Building a tree from zero leaves throws a `RangeError`. An empty tree has
 *   no defined root, so callers must handle emptiness explicitly before
 *   constructing one.
 *
 * Proofs:
 *   A proof is an ordered list of `{ hash, position }` steps from a leaf up to
 *   (but excluding) the root. `position` states where the SIBLING hash sits in
 *   the pair relative to the running hash:
 *   - `position: 'left'`  => `running = SHA-256(sibling || running)`
 *   - `position: 'right'` => `running = SHA-256(running || sibling)`
 *   Verification recomputes the root and compares it against the expected
 *   root using a constant-time comparison. Malformed inputs throw;
 *   well-formed but incorrect proofs simply return `false`.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Size in bytes of every canonical node hash produced by this module (SHA-256). */
export const HASH_SIZE_BYTES = 32;

export type MerklePosition = 'left' | 'right';

export interface MerkleTreeOptions {
  /**
   * When true, leaves must be exactly 32-byte SHA-256 digests and are used as-is.
   * When false (default), arbitrary leaf bytes are hashed with SHA-256.
   */
  readonly prehashed?: boolean;
}

/** One step of an inclusion proof, ordered leaf-to-root. */
export interface MerkleProofStep {
  /** The 32-byte sibling hash at this level. */
  readonly hash: Uint8Array;
  /** Which side of the pair the sibling occupies ('left' or 'right'). */
  readonly position: MerklePosition;
}

function sha256Concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  return createHash('sha256').update(left).update(right).digest();
}

function assertUint8Array(value: unknown, name: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Uint8Array`);
  }
}

function assertHashSize(value: Uint8Array, name: string): void {
  if (value.length !== HASH_SIZE_BYTES) {
    throw new RangeError(
      `${name} must be exactly ${HASH_SIZE_BYTES} bytes, received ${value.length}`,
    );
  }
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  assertUint8Array(a, 'first hash');
  assertUint8Array(b, 'second hash');
  assertHashSize(a, 'first hash');
  assertHashSize(b, 'second hash');
  return timingSafeEqual(a, b);
}

function normalizeLeafHash(leaf: unknown, prehashed: boolean, index: number): Uint8Array {
  assertUint8Array(leaf, `leaf at index ${index}`);
  if (prehashed) {
    assertHashSize(leaf, `prehashed leaf at index ${index}`);
    return Uint8Array.from(leaf);
  }
  return createHash('sha256').update(leaf).digest();
}

function parseProofStep(step: unknown, index: number): MerkleProofStep {
  if (typeof step !== 'object' || step === null) {
    throw new TypeError(`proof step at index ${index} must be an object`);
  }
  const candidate = step as { hash?: unknown; position?: unknown };
  assertUint8Array(candidate.hash, `proof step ${index} hash`);
  assertHashSize(candidate.hash, `proof step ${index} hash`);
  if (candidate.position !== 'left' && candidate.position !== 'right') {
    throw new TypeError(
      `proof step ${index} position must be 'left' or 'right', received ${String(candidate.position)}`,
    );
  }
  // Copy defensively so later mutation of caller-owned buffers cannot affect verification.
  return { hash: Uint8Array.from(candidate.hash), position: candidate.position };
}

function parseOptions(options?: MerkleTreeOptions): boolean {
  if (options === undefined) {
    return false;
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('options must be an object when provided');
  }
  const { prehashed } = options;
  if (prehashed !== undefined && typeof prehashed !== 'boolean') {
    throw new TypeError('options.prehashed must be a boolean when provided');
  }
  return prehashed === true;
}

function computeLevels(leafHashes: readonly Uint8Array[]): Uint8Array[][] {
  const levels: Uint8Array[][] = [leafHashes.map((h) => Uint8Array.from(h))];
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      // Odd-node rule: duplicate the trailing node with itself.
      const right = i + 1 < current.length ? current[i + 1] : left;
      next.push(sha256Concat(left, right));
    }
    levels.push(next);
  }
  return levels;
}

/**
 * A deterministic SHA-256 Merkle tree over an ordered set of leaves.
 * Instances hold only their own immutable copies of the tree; there is no
 * hidden global state.
 */
export class MerkleTree {
  private readonly levels: Uint8Array[][];
  private readonly prehashed: boolean;

  constructor(leaves: readonly Uint8Array[], options?: MerkleTreeOptions) {
    if (!Array.isArray(leaves)) {
      throw new TypeError('leaves must be an array of Uint8Array');
    }
    this.prehashed = parseOptions(options);

    // Empty-tree behaviour is explicitly defined: construction fails.
    if (leaves.length === 0) {
      throw new RangeError('cannot build a Merkle tree from zero leaves');
    }

    const leafHashes = leaves.map((leaf, index) =>
      normalizeLeafHash(leaf, this.prehashed, index),
    );
    this.levels = computeLevels(leafHashes);
  }

  /** Number of leaves in the tree. */
  get leafCount(): number {
    return this.levels[0].length;
  }

  /** A defensive copy of the 32-byte root hash. */
  get root(): Uint8Array {
    return Uint8Array.from(this.levels[this.levels.length - 1][0]);
  }

  /** A defensive copy of the canonical hash of the leaf at `index`. */
  getLeafHash(index: number): Uint8Array {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.leafCount) {
      throw new RangeError(`leaf index out of range: ${index}`);
    }
    return Uint8Array.from(this.levels[0][index]);
  }

  /** Inclusion proof for the leaf at `index`, ordered leaf-to-root. */
  getProof(index: number): MerkleProofStep[] {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.leafCount) {
      throw new RangeError(`leaf index out of range: ${index}`);
    }
    const proof: MerkleProofStep[] = [];
    let position = index;
    for (let levelIndex = 0; levelIndex < this.levels.length - 1; levelIndex += 1) {
      const level = this.levels[levelIndex];
      const isRightNode = position % 2 === 1;
      const siblingIndex = isRightNode ? position - 1 : position + 1;
      // For an unpaired trailing left node the odd-node rule duplicates it,
      // so the sibling is the node itself.
      const sibling =
        siblingIndex < level.length ? level[siblingIndex] : level[position];
      proof.push({
        hash: Uint8Array.from(sibling),
        position: isRightNode ? 'left' : 'right',
      });
      position = Math.floor(position / 2);
    }
    return proof;
  }

  /**
   * Verify that `leaf` (raw bytes, or a 32-byte digest when the tree was built
   * with `prehashed: true`) belongs in the tree with `root`, using `proof`.
   * Throws on malformed inputs; returns false for valid-format proofs that do
   * not reconstruct the root.
   */
  static verify(
    root: Uint8Array,
    leaf: Uint8Array,
    proof: readonly unknown[],
    options?: MerkleTreeOptions,
  ): boolean {
    const prehashed = parseOptions(options);
    assertUint8Array(root, 'root');
    assertHashSize(root, 'root');
    const leafHash = normalizeLeafHash(leaf, prehashed, 0);
    if (!Array.isArray(proof)) {
      throw new TypeError('proof must be an array of proof steps');
    }

    let running = leafHash;
    for (const [stepIndex, rawStep] of proof.entries()) {
      const step = parseProofStep(rawStep, stepIndex);
      running =
        step.position === 'left'
          ? sha256Concat(step.hash, running)
          : sha256Concat(running, step.hash);
    }

    return constantTimeEquals(running, root);
  }
}
