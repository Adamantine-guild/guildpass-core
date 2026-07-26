# Merkle Encoding Verification

## Scope

This document records the systematic equivalence verification between the
on-chain leaf-encoding logic in `MembershipNFT.claimMembership()` and the
off-chain (script-side) tree-generation logic in `MerkleTreeLib.sol` /
`GenerateMerkleTree.s.sol`.

The leaf encoding in both places must produce **byte-for-byte identical** output
for any given input `(index, wallet, communityId, expiresAt)`, because a root
published from the generator must accept proofs produced by the generator when
verified against the contract. Any divergence — field ordering, type encoding,
packing choice — would be a catastrophic silent-until-deployment failure.

## Encoding specification

Both sides implement:

```
leaf = keccak256(bytes.concat(keccak256(abi.encode(
    index,       // uint256
    wallet,      // address
    communityId, // string
    expiresAt    // uint256
))));
```

Key properties:

- **`abi.encode`** (never `abi.encodePacked`): length-prefixes the dynamic
  `string` field, eliminating field-boundary ambiguity.
- **Double keccak256**: the outer hash always receives exactly 32 bytes (a
  single bytes32), making it structurally distinct from internal tree nodes
  (which are `keccak256(abi.encodePacked(a, b))` for two 32-byte siblings = 64
  bytes of pre-image), providing second-preimage resistance.
- **Field ordering**: `(index, wallet, communityId, expiresAt)` must appear in
  this exact order in both the contract and the script.

## Verification methodology

### 1. Property-based / fuzz equivalence testing

`GenerateMerkleTreeFixture.t.sol` (this file) contains the following fuzz tests:

| Test | What it checks | Iterations | Leaves verified |
|------|---------------|-----------|-----------------|
| `testFuzz_RandomizedEndToEnd` | Generate random entries (1–1024 per run), build tree via MerkleTreeLib, set root, claim every entry on-chain | 256 | ~32K |
| `testFuzz_EdgeCaseBoundaryValues` | Boundary index/expiresAt/wallet values used as single-leaf trees | 256 | 256 |
| `testFuzz_TrickyCommunityIds` | Community IDs with null bytes, high-byte values, and special characters | 256 | ~8K |
| `testLargeTree_128LeavesAllClaimed` | Fixed 128-leaf tree, all proofs verified | 1 | 128 |
| **Total** | | **769** | **~40K+** |

### 2. Independent reference implementation cross-check

`testFuzz_IndependentImplementationRootAgreement` builds the same tree from
identical entries using **two independent implementations**:

- **Implementation A**: `MerkleTreeLib.leafHash` / `MerkleTreeLib.buildLevels`
  (the shared library used by the generator script and other tests)
- **Implementation B**: `_refLeafHash` / `_refBuildLevels` (from-scratch
  reimplementation in the test file, deliberately not sharing code with
  MerkleTreeLib)

Both produce identical roots across 256 fuzz runs. Additionally,
`testFuzz_ReferenceProofClaimsOnChain` deploys a fresh `MembershipNFT`, sets
the root from the reference implementation, and claims every entry using
reference-produced proofs — confirming on-chain acceptance of an independently
generated tree.

This cross-check catches shared-blind-spot bugs: if both the contract and
MerkleTreeLib contained the same subtle encoding error, the independent
implementation (written from scratch in the test file, guided only by the
NatSpec) would diverge and the test would fail.

### 3. Adversarial abi.encodePacked-ambiguity test

`testAdversarial_EncodePackedAmbiguity` and
`testAdversarial_EncodePackedLeafCollision` prove that the contract's
`abi.encode`-based leaf encoding is genuinely immune to the class of ambiguity
that `abi.encodePacked` suffers from:

1. **Ambiguity confirmed**: `abi.encodePacked("a","bc")` and
   `abi.encodePacked("ab","c")` produce identical byte sequences (both yield
   `0x616263`). This is the canonical example of dynamic-type boundary
   ambiguity in packed encoding.

2. **Encode immunity confirmed**: `abi.encode("a","bc")` and
   `abi.encode("ab","c")` produce **different** byte sequences (length prefixes
   distinguish the two cases). The same immunity applies to the full
   `(index, wallet, communityId, expiresAt)` tuple.

3. **Distinct leaves for encodePacked-adjacent community IDs**: Leaves
   constructed with community IDs "a", "ab", and "abc" (which share the
   prefix-suffix relationship that makes them encodePacked-ambiguous) all
   produce distinct leaves under the contract's `abi.encode`-based encoding.

4. **End-to-end verification**: Two trees with community IDs "a" and "abc"
   both produce valid, independently claimable proofs on-chain, confirming no
   cross-contamination.

## Findings

**No encoding divergence was found.** The on-chain and off-chain leaf encoding
logic produce identical outputs across all tested inputs (~40K+ leaves
verified). Key specific confirmations:

- `MerkleTreeLib.leafHash` matches `MembershipNFT.claimMembership`'s leaf
  construction: **confirmed** (every fuzz test implicitly checks this).
- The `GenerateMerkleTree` script's sorted-by-wallet tree construction
  produces proofs that `claimMembership` accepts: **confirmed** (fixture test +
  fuzz tests).
- The `abi.encode` choice is immune to `abi.encodePacked`-style ambiguity:
  **confirmed** (adversarial test).
- An independently written (non-code-sharing) reference implementation
  produces byte-identical roots and proofs: **confirmed**.

## Risk assessment

The encoding is considered **airtight** under the current scheme. The most
likely practical risk would be a future change to the field set
(e.g. adding a new field to the leaf tuple) that updates the contract but not
the script, or vice versa. The fuzz tests in this file will detect such a
divergence immediately if run as part of CI — the `testFuzz_RandomizedEndToEnd`
test in particular would fail on the first fuzz iteration if the contract and
library disagree on any encoding detail.

## Running the verification

```bash
forge test --match-path contracts/test/GenerateMerkleTreeFixture.t.sol -vv
```

Expected output: 11 tests passed (3 original fixture tests + 8 new
verification tests).
