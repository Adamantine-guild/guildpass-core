import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HASH_SIZE_BYTES, MerkleTree } from './index.js';

const hexToBytes = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error(`invalid hex: ${hex}`);
  }
  return new Uint8Array(hex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)));
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const leaf = (value: string): Uint8Array => new TextEncoder().encode(value);

// Fixed expected vectors, computed independently with node:crypto:
//   sha256('a')                                   -> ca9781...
//   root(['a','b'])                               -> e5a01f...
//   root(['a','b','c']) (odd trailing node duplicated)
//                                                 -> d31a37...
//   prehashed root([sha256('x'), sha256('y')])    -> f150e8...
const EXPECTED_LEAF_A =
  'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb';
const EXPECTED_ROOT_AB =
  'e5a01fee14e0ed5c48714f22180f25ad8365b53f9779f79dc4a3d7e93963f94a';
const EXPECTED_ROOT_ABC =
  'd31a37ef6ac14a2db1470c4316beb5592e6afd4465022339adafda76a18ffabe';
const EXPECTED_ROOT_PREHASHED_XY =
  'f150e8508bbbc8be5232a999a3af77b03f4430f86e7b59593476710a5acb0156';

describe('MerkleTree construction', () => {
  it('produces the fixed single-leaf root vector', () => {
    const tree = new MerkleTree([leaf('a')]);
    expect(bytesToHex(tree.root)).toBe(EXPECTED_LEAF_A);
    expect(tree.leafCount).toBe(1);
  });

  it('produces the fixed two-leaf root vector', () => {
    const tree = new MerkleTree([leaf('a'), leaf('b')]);
    expect(bytesToHex(tree.root)).toBe(EXPECTED_ROOT_AB);
  });

  it('handles an odd number of leaves deterministically against a fixed vector', () => {
    const tree = new MerkleTree([leaf('a'), leaf('b'), leaf('c')]);
    // Level 1: H(H(a)||H(b)), H(H(c)||H(c)) — trailing node duplicated with itself.
    expect(bytesToHex(tree.root)).toBe(EXPECTED_ROOT_ABC);
    expect(new MerkleTree([leaf('a'), leaf('b'), leaf('c')]).root).toEqual(
      tree.root,
    );
  });

  it('supports prehashed 32-byte leaves against a fixed vector', () => {
    const x = createHash('sha256').update('x').digest();
    const y = createHash('sha256').update('y').digest();
    const tree = new MerkleTree([new Uint8Array(x), new Uint8Array(y)], {
      prehashed: true,
    });
    expect(bytesToHex(tree.root)).toBe(EXPECTED_ROOT_PREHASHED_XY);
  });

  it('rejects empty trees with an explicit error', () => {
    expect(() => new MerkleTree([])).toThrow(RangeError);
  });

  it('rejects non-Uint8Array leaves and wrong-sized prehashed leaves', () => {
    // @ts-expect-error intentionally malformed input
    expect(() => new MerkleTree(['a', 'b'])).toThrow(TypeError);
    expect(
      () =>
        new MerkleTree([leaf('too short for prehashed mode')], {
          prehashed: true,
        }),
    ).toThrow(RangeError);
  });
});

describe('determinism', () => {
  it('gives identical roots for identical ordered input across instances', () => {
    const leaves = ['g1', 'g2', 'g3', 'g4'].map(leaf);
    expect(new MerkleTree(leaves).root).toEqual(new MerkleTree(leaves).root);
  });

  it('changes the root when any leaf changes', () => {
    const baseline = new MerkleTree([leaf('a'), leaf('b'), leaf('c')]).root;
    expect(new MerkleTree([leaf('a'), leaf('X'), leaf('c')]).root).not.toEqual(
      baseline,
    );
    expect(new MerkleTree([leaf('A'), leaf('b'), leaf('c')]).root).not.toEqual(
      baseline,
    );
  });

  it('preserves caller order rather than sorting', () => {
    const ab = new MerkleTree([leaf('a'), leaf('b')]).root;
    const ba = new MerkleTree([leaf('b'), leaf('a')]).root;
    expect(ab).not.toEqual(ba);
  });

  it('does not mutate caller-owned leaf buffers', () => {
    const raw = new Uint8Array(createHash('sha256').update('a').digest());
    const copy = new Uint8Array(raw);
    new MerkleTree([raw], { prehashed: true });
    expect(raw).toEqual(copy);
  });
});

describe('inclusion proofs', () => {
  const leaves = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(leaf); // odd count

  it('generates and verifies a valid proof for every leaf', () => {
    const tree = new MerkleTree(leaves);
    leaves.forEach((_, index) => {
      const proof = tree.getProof(index);
      expect(MerkleTree.verify(tree.root, leaves[index], proof)).toBe(true);
    });
  });

  it('emits proof positions consistent with the documented semantics', () => {
    const tree = new MerkleTree(leaves);
    const proofForFirstLeaf = tree.getProof(0);
    // Leaf 0 is always a left operand; its sibling sits on the right.
    expect(proofForFirstLeaf[0].position).toBe('right');

    const proofForSecondLeaf = tree.getProof(1);
    // Leaf 1 is a right operand; its sibling sits on the left.
    expect(proofForSecondLeaf[0].position).toBe('left');

    // The last leaf in an odd-sized bottom level is its own duplicate sibling.
    const proofForLastLeaf = tree.getProof(leaves.length - 1);
    expect(proofForLastLeaf[0].hash).toEqual(tree.getLeafHash(leaves.length - 1));
  });

  it('rejects a proof built for a different leaf index', () => {
    const tree = new MerkleTree(leaves);
    expect(MerkleTree.verify(tree.root, leaves[0], tree.getProof(1))).toBe(false);
  });

  it('rejects modified leaves during verification', () => {
    const tree = new MerkleTree(leaves);
    const forgedLeaf = leaf('forged');
    expect(MerkleTree.verify(tree.root, forgedLeaf, tree.getProof(0))).toBe(false);
  });

  it('rejects modified proof hashes during verification', () => {
    const tree = new MerkleTree(leaves);
    const proof = tree.getProof(0).map((step) => ({ ...step }));
    const tampered = createHash('sha256').update('tampered').digest();
    proof[0] = { ...proof[0], hash: new Uint8Array(tampered) };
    expect(MerkleTree.verify(tree.root, leaves[0], proof)).toBe(false);
  });

  it('rejects flipped proof positions during verification', () => {
    const tree = new MerkleTree(leaves);
    const proof = tree
      .getProof(0)
      .map((step) => ({
        hash: step.hash,
        position: step.position === 'left' ? ('right' as const) : ('left' as const),
      }));
    expect(MerkleTree.verify(tree.root, leaves[0], proof)).toBe(false);
  });

  it('rejects malformed hashes with explicit errors', () => {
    const tree = new MerkleTree(leaves);
    const badRoot = new Uint8Array(HASH_SIZE_BYTES - 1);
    expect(() => MerkleTree.verify(badRoot, leaves[0], tree.getProof(0))).toThrow(
      RangeError,
    );

    const truncatedSibling = { ...tree.getProof(0)[0], hash: new Uint8Array(16) };
    expect(() => MerkleTree.verify(tree.root, leaves[0], [truncatedSibling])).toThrow(
      RangeError,
    );

    const badPosition = { ...tree.getProof(0)[0], position: 'middle' };
    expect(() => MerkleTree.verify(tree.root, leaves[0], [badPosition])).toThrow(
      TypeError,
    );
  });

  it('supports prehashed verification of raw digests', () => {
    const digests = ['x', 'y', 'z'].map((v) =>
      new Uint8Array(createHash('sha256').update(v).digest()),
    );
    const tree = new MerkleTree(digests, { prehashed: true });
    digests.forEach((digest, index) => {
      expect(
        MerkleTree.verify(tree.root, digest, tree.getProof(index), {
          prehashed: true,
        }),
      ).toBe(true);
    });
    expect(
      MerkleTree.verify(tree.root, digests[0], tree.getProof(1), {
        prehashed: true,
      }),
    ).toBe(false);
  });

  it('covers single-leaf proofs (empty proof verifies)', () => {
    const tree = new MerkleTree([leaf('only')]);
    expect(tree.getProof(0)).toHaveLength(0);
    expect(MerkleTree.verify(tree.root, leaf('only'), [])).toBe(true);
    expect(MerkleTree.verify(tree.root, leaf('other'), [])).toBe(false);
  });

  it('rejects out-of-range proof indices', () => {
    const tree = new MerkleTree(leaves);
    expect(() => tree.getProof(-1)).toThrow(RangeError);
    expect(() => tree.getProof(leaves.length)).toThrow(RangeError);
  });
});
