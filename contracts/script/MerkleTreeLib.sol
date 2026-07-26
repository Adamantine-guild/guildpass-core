// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Shared Merkle tree construction logic for the GuildPass batch-claim
/// generator (GenerateMerkleTree.s.sol) and its test fixtures. This is the
/// single implementation of the tree-building algorithm - both the generator
/// script and the test suite import it, so there is no second copy of the
/// hashing logic that could silently drift out of sync with the other.
///
/// CRITICAL: hashPair below reproduces OpenZeppelin's
/// Hashes.commutativeKeccak256 exactly:
///
///   a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a))
///
/// i.e. a raw 64-byte concatenation of the two 32-byte words in ascending
/// numeric order, keccak256'd. It is NOT keccak256(abi.encode(a, b)) - for two
/// fixed-size bytes32 values abi.encodePacked and abi.encode happen to agree,
/// but MerkleProof.sol's actual implementation uses raw memory concatenation
/// via inline assembly, not an ABI encoder call. Reproducing the exact
/// operation (not just an equivalent one) here means a reviewer can diff this
/// function against OpenZeppelin's Hashes.sol line-by-line instead of trusting
/// that two differently-phrased hash calls happen to coincide.
///
/// Leaf hashing (leafHash below) uses abi.encode, not abi.encodePacked -
/// deliberately different from hashPair - because a leaf commits a
/// heterogeneous, dynamically-typed tuple (index, wallet, communityId string,
/// expiresAt), where packed encoding is genuinely ambiguous. See
/// MembershipNFT.sol's "Merkle-based batch mint/renew claim path" section for
/// the full rationale; this function must stay byte-for-byte identical to the
/// leaf construction there.
library MerkleTreeLib {
    /// @dev OZ MerkleProof-compatible commutative pair hash.
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Must match MembershipNFT.claimMembership's leaf construction exactly.
    function leafHash(uint256 index, address wallet, string memory communityId, uint256 expiresAt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(index, wallet, communityId, expiresAt))));
    }

    /// @dev Builds every level of the tree bottom-up from a leaf array.
    /// levels[0] is the input leaves; levels[levels.length - 1] is a
    /// single-element array holding the root. An odd trailing node at any
    /// level is promoted unchanged to the next level rather than paired with
    /// itself (avoids a duplicate-leaf second-preimage footgun where pairing
    /// a node with itself would let an attacker who knows one leaf compute a
    /// valid-looking sibling).
    function buildLevels(bytes32[] memory leaves)
        internal
        pure
        returns (bytes32[][] memory levels)
    {
        require(leaves.length > 0, "MerkleTreeLib: empty leaf set");

        uint256 numLevels = 1;
        uint256 n = leaves.length;
        while (n > 1) {
            n = (n + 1) / 2;
            numLevels++;
        }

        levels = new bytes32[][](numLevels);
        levels[0] = leaves;
        for (uint256 lvl = 0; lvl + 1 < numLevels; lvl++) {
            bytes32[] memory cur = levels[lvl];
            uint256 nextLen = (cur.length + 1) / 2;
            bytes32[] memory next = new bytes32[](nextLen);
            for (uint256 i = 0; i < nextLen; i++) {
                uint256 l = i * 2;
                uint256 r = l + 1;
                next[i] = r < cur.length ? hashPair(cur[l], cur[r]) : cur[l];
            }
            levels[lvl + 1] = next;
        }
    }

    function root(bytes32[][] memory levels) internal pure returns (bytes32) {
        return levels[levels.length - 1][0];
    }

    /// @dev Sibling proof path from levels[0][index] up to the root.
    function proofFor(bytes32[][] memory levels, uint256 index)
        internal
        pure
        returns (bytes32[] memory)
    {
        uint256 numLevels = levels.length;
        bytes32[] memory buf = new bytes32[](numLevels);
        uint256 len = 0;
        uint256 idx = index;
        for (uint256 lvl = 0; lvl + 1 < numLevels; lvl++) {
            bytes32[] memory cur = levels[lvl];
            uint256 siblingIdx = idx % 2 == 0 ? idx + 1 : idx - 1;
            if (siblingIdx < cur.length) {
                buf[len++] = cur[siblingIdx];
            }
            idx /= 2;
        }
        bytes32[] memory proof = new bytes32[](len);
        for (uint256 i = 0; i < len; i++) {
            proof[i] = buf[i];
        }
        return proof;
    }
}
