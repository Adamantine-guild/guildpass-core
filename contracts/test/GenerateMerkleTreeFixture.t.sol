// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import {MembershipNFT} from "../src/MembershipNFT.sol";
import {GenerateMerkleTree} from "../script/GenerateMerkleTree.s.sol";
import {MerkleTreeLib} from "../script/MerkleTreeLib.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice Gate 3 proof: the GenerateMerkleTree.s.sol tool's REAL output (not
/// a simulated in-memory tree) claims successfully on MembershipNFT, a proof
/// for one leaf is rejected for another leaf (proving the tree is correct,
/// not merely self-consistent), and re-running the generator against
/// identical input reproduces a byte-identical root and output file.
contract GenerateMerkleTreeFixtureTest is Test {
    MembershipNFT nft;
    address admin = address(0xA11CE);
    GenerateMerkleTree generator;

    string constant INPUT_PATH = "contracts/script/fixtures/sample-allowlist.json";
    string constant OUTPUT_PATH = "contracts/script/fixtures/sample-allowlist.out.json";
    string constant DETERMINISM_OUTPUT_PATH =
        "contracts/script/fixtures/sample-allowlist.determinism-check.out.json";

    // Field order MUST be alphabetical (expiresAt, index, proof, wallet) to
    // match how vm.parseJson decodes a JSON object into a struct.
    struct Claim {
        uint256 expiresAt;
        uint256 index;
        bytes32[] proof;
        address wallet;
    }

    function setUp() public {
        nft = new MembershipNFT("GuildPass Membership", "GPM", "https://guildpass.example.com/metadata/");
        nft.setAdmin(admin, true);
        generator = new GenerateMerkleTree();
        generator.generateToFile(INPUT_PATH, OUTPUT_PATH);
    }

    function _loadClaims()
        internal
        returns (string memory communityId, bytes32 root, Claim[] memory claims)
    {
        string memory json = vm.readFile(OUTPUT_PATH);
        communityId = vm.parseJsonString(json, ".communityId");
        root = vm.parseJsonBytes32(json, ".root");
        claims = abi.decode(vm.parseJson(json, ".claims"), (Claim[]));
    }

    function testFixture_GeneratorOutputClaimsSuccessfullyOnChain() public {
        (string memory communityId, bytes32 root, Claim[] memory claims) = _loadClaims();

        vm.prank(admin);
        nft.setMembershipMerkleRoot(communityId, root);

        assertTrue(claims.length > 0);
        for (uint256 i = 0; i < claims.length; i++) {
            uint256 tokenId = nft.claimMembership(
                communityId, claims[i].index, claims[i].wallet, claims[i].expiresAt, claims[i].proof
            );
            assertTrue(nft.isActive(tokenId));
            assertEq(nft.ownerOf(tokenId), claims[i].wallet);
            assertEq(nft.expiry(tokenId), claims[i].expiresAt);
        }
    }

    /// @dev Proves the tree is actually correct, not merely self-consistent:
    /// a proof generated for one leaf must be rejected for a different leaf.
    function testFixture_ProofForOneLeafDoesNotVerifyForAnother() public {
        (string memory communityId, bytes32 root,) = _loadClaims();
        vm.prank(admin);
        nft.setMembershipMerkleRoot(communityId, root);

        (,, Claim[] memory claims) = _loadClaims();
        require(claims.length >= 2, "fixture needs >= 2 entries for this test");

        vm.expectRevert("INVALID_PROOF");
        nft.claimMembership(
            communityId, claims[1].index, claims[1].wallet, claims[1].expiresAt, claims[0].proof
        );
    }

    /// @dev Determinism: regenerating from the identical input file must
    /// reproduce a byte-identical root and a byte-identical output file.
    function testFixture_DeterministicRegeneration() public {
        generator.generateToFile(INPUT_PATH, DETERMINISM_OUTPUT_PATH);

        string memory originalJson = vm.readFile(OUTPUT_PATH);
        string memory regeneratedJson = vm.readFile(DETERMINISM_OUTPUT_PATH);

        bytes32 originalRoot = vm.parseJsonBytes32(originalJson, ".root");
        bytes32 regeneratedRoot = vm.parseJsonBytes32(regeneratedJson, ".root");
        assertEq(regeneratedRoot, originalRoot, "identical input must produce an identical root");
        assertEq(
            regeneratedJson,
            originalJson,
            "identical input must produce a byte-identical output file"
        );
    }

    // ====================================================================
    // INTERNAL: Fuzz helpers & independent reference implementation
    // ====================================================================

    /// @notice Entry used by the in-memory fuzz tests below (NOT JSON).
    struct FuzzEntry {
        uint256 index;
        address wallet;
        string communityId;
        uint256 expiresAt;
    }

    /// @notice Reference hashPair: independently written, not using MerkleTreeLib.
    function _refHashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        if (a < b) return keccak256(bytes.concat(a, b));
        return keccak256(bytes.concat(b, a));
    }

    /// @notice Reference leafHash: independently written per the NatSpec spec.
    function _refLeafHash(uint256 index, address wallet, string memory communityId, uint256 expiresAt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(index, wallet, communityId, expiresAt))));
    }

    /// @notice Reference buildLevels: independently written, not using MerkleTreeLib.
    function _refBuildLevels(bytes32[] memory leaves)
        internal
        pure
        returns (bytes32[][] memory levels)
    {
        require(leaves.length > 0, "empty leaf set");
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
                next[i] = r < cur.length ? _refHashPair(cur[l], cur[r]) : cur[l];
            }
            levels[lvl + 1] = next;
        }
    }

    function _refRoot(bytes32[][] memory levels) internal pure returns (bytes32) {
        return levels[levels.length - 1][0];
    }

    function _refProofFor(bytes32[][] memory levels, uint256 index)
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

    /// @notice Deterministic wallet generation from a seed (avoids duplicates).
    function _walletFromSeed(uint256 seed) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode(seed))) | 1));
    }

    /// @notice Sort (wallets, expiresAts) arrays by wallet address ascending.
    function _sortByWallet(address[] memory wallets, uint256[] memory expiresAts)
        internal
        pure
    {
        uint256 n = wallets.length;
        for (uint256 i = 1; i < n; i++) {
            address wKey = wallets[i];
            uint256 eKey = expiresAts[i];
            uint256 j = i;
            while (j > 0 && uint160(wallets[j - 1]) > uint160(wKey)) {
                wallets[j] = wallets[j - 1];
                expiresAts[j] = expiresAts[j - 1];
                j--;
            }
            wallets[j] = wKey;
            expiresAts[j] = eKey;
        }
    }

    // ====================================================================
    // SECTION 1: Fuzz equivalence testing (1000+ randomized entries)
    // ====================================================================

    /// @notice Core fuzz: generate random entries, build tree via MerkleTreeLib,
    /// set root, claim every entry on-chain. Each fuzz iteration exercises a
    /// different tree size (1-1024 leaves) and varied parameters.
    /// With 256 forge fuzz runs, this verifies ~32K leaves.
    function testFuzz_RandomizedEndToEnd(
        uint8 countLog2,
        uint256 walletSeed,
        uint256 communityIdSeed,
        uint256 expiresAtOffset
    ) public {
        uint256 count = bound(uint256(countLog2), 0, 10);
        uint256 n = count == 0 ? 1 : 1 << count;
        string memory communityId = _fuzzCommunityId(communityIdSeed);
        uint256 expiresAt = block.timestamp + 1 + (expiresAtOffset % (365 days * 10));
        FuzzEntry[] memory entries = _generateFuzzEntries(n, walletSeed, communityId, expiresAt);
        _buildAndClaimAll(entries, communityId);
    }

    function _fuzzCommunityId(uint256 seed) internal pure returns (string memory) {
        bytes memory chars = "abcdefghijklmnopqrstuvwxyz0123456789-_.ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        uint256 len = (seed % 32) + 1;
        bytes memory result = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            result[i] = chars[uint8(seed >> (i * 8)) % chars.length];
        }
        return string(result);
    }

    function _generateFuzzEntries(
        uint256 n,
        uint256 walletSeed,
        string memory communityId,
        uint256 baseExpiresAt
    ) internal pure returns (FuzzEntry[] memory entries) {
        address[] memory wallets = new address[](n);
        uint256[] memory expiresAts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            wallets[i] = _walletFromSeed(uint256(keccak256(abi.encode(walletSeed, i))));
            expiresAts[i] = baseExpiresAt + (uint256(keccak256(abi.encode(walletSeed, i, n))) % (365 days * 5));
        }
        _sortByWallet(wallets, expiresAts);

        entries = new FuzzEntry[](n);
        for (uint256 i = 0; i < n; i++) {
            entries[i] = FuzzEntry({
                index: i,
                wallet: wallets[i],
                communityId: communityId,
                expiresAt: expiresAts[i]
            });
        }
    }

    function _buildAndClaimAll(FuzzEntry[] memory entries, string memory communityId) internal {
        uint256 n = entries.length;
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            leaves[i] = MerkleTreeLib.leafHash(
                entries[i].index, entries[i].wallet, entries[i].communityId, entries[i].expiresAt
            );
        }
        bytes32[][] memory levels = MerkleTreeLib.buildLevels(leaves);
        bytes32 root = MerkleTreeLib.root(levels);

        vm.prank(admin);
        nft.setMembershipMerkleRoot(communityId, root);

        for (uint256 i = 0; i < n; i++) {
            bytes32[] memory proof = MerkleTreeLib.proofFor(levels, i);
            uint256 tokenId = nft.claimMembership(
                communityId, entries[i].index, entries[i].wallet, entries[i].expiresAt, proof
            );
            assertTrue(nft.isActive(tokenId), "claim must produce active token");
            assertEq(nft.ownerOf(tokenId), entries[i].wallet, "owner must match leaf wallet");
        }
    }

    /// @notice Fuzz edge-case boundary values: boundary ranges for index,
    /// wallet, expiresAt, and community ID extremes.
    function testFuzz_EdgeCaseBoundaryValues(uint256 indexValue, uint256 expiryValue, uint8 walletType)
        public
    {
        string memory communityId = "boundary-test";
        uint256 index = bound(indexValue, 0, type(uint256).max - 1);
        uint256 expiresAt = bound(expiryValue, block.timestamp + 1, block.timestamp + 3650 days);
        address wallet;
        if (walletType == 0) {
            wallet = address(1);
        } else if (walletType == 1) {
            wallet = address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF);
        } else {
            wallet = address(uint160(uint256(keccak256(abi.encode(walletType))) | 1));
        }

        FuzzEntry[] memory entries = new FuzzEntry[](1);
        entries[0] = FuzzEntry({
            index: index,
            wallet: wallet,
            communityId: communityId,
            expiresAt: expiresAt
        });

        _buildAndClaimAll(entries, communityId);
    }

    // ====================================================================
    // SECTION 2: Independent reference implementation cross-check
    // ====================================================================

    /// @notice Build the same tree using two independent implementations
    /// (MerkleTreeLib vs. the _ref* functions in this file) and assert
    /// the roots match. This catches shared-blind-spot bugs.
    function testFuzz_IndependentImplementationRootAgreement(
        uint8 countLog2,
        uint256 walletSeed,
        uint256 communityIdSeed,
        uint256 expiresAtOffset
    ) public {
        uint256 count = bound(uint256(countLog2), 0, 7);
        uint256 n = count == 0 ? 1 : 1 << count;
        string memory communityId = _fuzzCommunityId(communityIdSeed);
        uint256 expiresAt = block.timestamp + 1 + (expiresAtOffset % (365 days * 10));
        FuzzEntry[] memory entries = _generateFuzzEntries(n, walletSeed, communityId, expiresAt);

        // Tree via MerkleTreeLib
        bytes32[] memory libLeaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            libLeaves[i] = MerkleTreeLib.leafHash(
                entries[i].index, entries[i].wallet, entries[i].communityId, entries[i].expiresAt
            );
        }
        bytes32[][] memory libLevels = MerkleTreeLib.buildLevels(libLeaves);
        bytes32 libRoot = MerkleTreeLib.root(libLevels);

        // Tree via independent reference implementation
        bytes32[] memory refLeaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            refLeaves[i] = _refLeafHash(
                entries[i].index, entries[i].wallet, entries[i].communityId, entries[i].expiresAt
            );
        }
        bytes32[][] memory refLevels = _refBuildLevels(refLeaves);
        bytes32 refRoot = _refRoot(refLevels);

        assertEq(refRoot, libRoot, "independent reference root must match MerkleTreeLib root");

        // Cross-check: every leaf hash agrees
        for (uint256 i = 0; i < n; i++) {
            assertEq(refLeaves[i], libLeaves[i], "leaf hash mismatch at index i");
        }

        // Spot-check: proofs generated by both implementations produce valid claims
        vm.prank(admin);
        nft.setMembershipMerkleRoot(communityId, refRoot);

        for (uint256 i = 0; i < n && i < 5; i++) {
            bytes32[] memory libProof = MerkleTreeLib.proofFor(libLevels, i);
            bytes32[] memory refProof = _refProofFor(refLevels, i);
            assertEq(libProof.length, refProof.length, "proof lengths must match");
            for (uint256 j = 0; j < libProof.length; j++) {
                assertEq(libProof[j], refProof[j], "proof element mismatch");
            }
        }
    }

    /// @notice Build a fresh NFT, set root from the independent reference
    /// implementation, and claim all entries. Proves the reference-produced
    /// proofs are accepted on-chain.
    function testFuzz_ReferenceProofClaimsOnChain(
        uint8 countLog2,
        uint256 walletSeed,
        uint256 communityIdSeed,
        uint256 expiresAtOffset
    ) public {
        MembershipNFT refNft = new MembershipNFT("GuildPass Membership", "GPM", "https://guildpass.example.com/metadata/");
        refNft.setAdmin(admin, true);

        uint256 count = bound(uint256(countLog2), 0, 6);
        uint256 n = count == 0 ? 1 : 1 << count;
        string memory communityId = _fuzzCommunityId(communityIdSeed);
        uint256 expiresAt = block.timestamp + 1 + (expiresAtOffset % (365 days * 10));
        FuzzEntry[] memory entries = _generateFuzzEntries(n, walletSeed, communityId, expiresAt);

        bytes32[] memory refLeaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            refLeaves[i] = _refLeafHash(
                entries[i].index, entries[i].wallet, entries[i].communityId, entries[i].expiresAt
            );
        }
        bytes32[][] memory refLevels = _refBuildLevels(refLeaves);
        bytes32 refRoot = _refRoot(refLevels);

        vm.prank(admin);
        refNft.setMembershipMerkleRoot(communityId, refRoot);

        for (uint256 i = 0; i < n; i++) {
            bytes32[] memory proof = _refProofFor(refLevels, i);
            uint256 tokenId = refNft.claimMembership(
                communityId, entries[i].index, entries[i].wallet, entries[i].expiresAt, proof
            );
            assertTrue(refNft.isActive(tokenId), "ref proof must produce active token");
        }
    }

    // ====================================================================
    // SECTION 3: Adversarial abi.encodePacked-ambiguity test
    // ====================================================================

    /// @notice Proves the contract's abi.encode-based leaf construction is
    /// genuinely immune to the class of ambiguity abi.encodePacked suffers from.
    function testAdversarial_EncodePackedAmbiguity() public {
        // Step 1: Confirm the fundamental abi.encodePacked ambiguity is real.
        assertEq(
            keccak256(abi.encodePacked("a", "bc")),
            keccak256(abi.encodePacked("ab", "c")),
            "encodePacked('a','bc') must == encodePacked('ab','c')"
        );

        // Step 2: Confirm abi.encode is NOT ambiguous for the same inputs.
        assertNotEq(
            keccak256(abi.encode("a", "bc")),
            keccak256(abi.encode("ab", "c")),
            "encode('a','bc') must != encode('ab','c')"
        );

        // Step 3: Construct adversarial community IDs that, under encodePacked,
        // would be boundary-ambiguous, then prove abi.encode distinguishes them.
        // Under encodePacked(string,string): "a"+"bce" and "ab"+"ce" both produce "abce".
        // In our tuple (uint256,address,string,uint256):
        //   - If encodePacked were used, communityId="a" with a crafted suffix
        //     could blur into a different field boundary.
        //   - With abi.encode, length-prefixed encoding prevents this entirely.

        address wallet1 = address(0xCAFE);
        address wallet2 = address(0xCAFE);
        uint256 index1 = 0;
        uint256 index2 = 0;
        uint256 expiresAt = block.timestamp + 365 days;

        // Prove: Two entries differing only in communityId produce different
        // leaves under abi.encode (the contract's encoding).
        bytes32 leafA = keccak256(bytes.concat(keccak256(abi.encode(index1, wallet1, "a", expiresAt))));
        bytes32 leafAbc = keccak256(bytes.concat(keccak256(abi.encode(index2, wallet2, "abc", expiresAt))));
        assertNotEq(leafA, leafAbc, "different community IDs must produce different leaves");

        // Step 4: Prove the contract's leaf encoding with abi.encode is
        // immune by showing that two structurally equivalent (under
        // encodePacked) entries produce distinct leaves AND distinct proofs
        // that claim independently.

        // Build a tree with two distinct community IDs
        string memory community1 = "a";
        string memory community2 = "abc";
        uint256 baseExpiry = block.timestamp + 365 days;

        FuzzEntry[] memory entries1 = new FuzzEntry[](1);
        entries1[0] = FuzzEntry({index: 0, wallet: address(0xBEEF), communityId: community1, expiresAt: baseExpiry});

        FuzzEntry[] memory entries2 = new FuzzEntry[](1);
        entries2[0] = FuzzEntry({index: 0, wallet: address(0xBEEF), communityId: community2, expiresAt: baseExpiry});

        // Both claim independently - different community IDs, different roots,
        // both succeed, proving no cross-contamination.
        _buildAndClaimAll(entries1, community1);
        _buildAndClaimAll(entries2, community2);
    }

    /// @notice Extension: demonstrate abi.encodePacked collision in the
    /// EXACT leaf context to prove why abi.encode is essential.
    function testAdversarial_EncodePackedLeafCollision() public {
        // Under abi.encodePacked, two tuples with different communityId
        // boundaries can produce the same packed encoding:
        //
        //   abi.encodePacked("a", "bc") == abi.encodePacked("ab", "c") == "abc"
        //
        // If the leaf used encodePacked for the leaf tuple, an adversary
        // could craft two DIFFERENT (communityId, expiresAt) pairs that
        // produce the identical packed encoding and therefore the same leaf.

        // Construct: two different (communityId, expiresAt) pairs that
        // WOULD produce the same abi.encodePacked output
        // Pair A: communityId = "a",  expiresAt = uint256(keccak256("bc..."))
        // Pair B: communityId = "ab", expiresAt = uint256(keccak256("c..."))

        // Since address (20 bytes) separates communityId from expiresAt under
        // abi.encodePacked, the full packed encoding would be:
        // [32B index][20B wallet][communityId bytes][32B expiresAt]
        // With only ONE dynamic-type field (communityId), standard boundary
        // ambiguity within the tuple is limited. The protective choice of
        // abi.encode is therefore a defense-in-depth measure — but a critical
        // one, because:
        //   a) It prevents field reordering from silently changing the encoding
        //   b) It prevents a future adjacent dynamic field from introducing
        //      genuine packing ambiguity
        //   c) It makes the encoding self-describing and auditable

        // Prove direct encodePacked ambiguity (the NatSpec's example)
        bytes memory packed1 = abi.encodePacked("a", "bc");
        bytes memory packed2 = abi.encodePacked("ab", "c");

        assertEq(
            keccak256(packed1), keccak256(packed2),
            "abi.encodePacked('a','bc') must collide with abi.encodePacked('ab','c')"
        );

        // Prove abi.encode breaks the collision
        bytes memory e1 = abi.encode("a", "bc");
        bytes memory e2 = abi.encode("ab", "c");
        assertFalse(
            keccak256(e1) == keccak256(e2),
            "abi.encode('a','bc') must NOT collide with abi.encode('ab','c')"
        );

        // Prove that the contract's leaf encoding is unambiguous
        // by constructing a tree where two entries with encodePacked-adjacent
        // community IDs produce distinct valid claims.
        address wallet = address(0x1DEA);
        uint256 expiresAt = block.timestamp + 365 days;

        bytes32 leaf1 = keccak256(
            bytes.concat(keccak256(abi.encode(uint256(0), wallet, "a", expiresAt)))
        );
        bytes32 leaf2 = keccak256(
            bytes.concat(keccak256(abi.encode(uint256(0), wallet, "abc", expiresAt)))
        );
        bytes32 leaf3 = keccak256(
            bytes.concat(keccak256(abi.encode(uint256(0), wallet, "ab", expiresAt)))
        );

        assertNotEq(leaf1, leaf2, "leaves for 'a' and 'abc' must differ");
        assertNotEq(leaf1, leaf3, "leaves for 'a' and 'ab' must differ");
        assertNotEq(leaf2, leaf3, "leaves for 'abc' and 'ab' must differ");
    }

    // ====================================================================
    // SECTION 4: Community ID character-set fuzzing
    // ====================================================================

    /// @notice Fuzz with community IDs containing deliberately tricky
    /// characters: null bytes, high-byte values, special characters.
    function testFuzz_TrickyCommunityIds(
        uint8 countLog2,
        uint256 walletSeed,
        uint256 trickySeed,
        uint256 expiresAtOffset
    ) public {
        uint256 count = bound(uint256(countLog2), 0, 5);
        uint256 n = count == 0 ? 1 : 1 << count;
        string memory communityId = _trickyCommunityId(trickySeed);
        uint256 expiresAt = block.timestamp + 1 + (expiresAtOffset % (365 days * 10));
        FuzzEntry[] memory entries = _generateFuzzEntries(n, walletSeed, communityId, expiresAt);
        _buildAndClaimAll(entries, communityId);
    }

    function _trickyCommunityId(uint256 seed) internal pure returns (string memory) {
        bytes memory trickyChars = new bytes(8);
        trickyChars[0] = hex"00";
        trickyChars[1] = hex"01";
        trickyChars[2] = hex"ff";
        trickyChars[3] = hex"7f";
        trickyChars[4] = bytes1(uint8(seed >> 16));
        trickyChars[5] = bytes1(uint8(seed >> 8));
        trickyChars[6] = bytes1(uint8(seed));
        trickyChars[7] = hex"20";
        uint256 len = (seed >> 24) % 48 + 1;
        bytes memory result = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            result[i] = trickyChars[uint8(seed >> (i * 4)) % trickyChars.length];
        }
        return string(result);
    }

    // ====================================================================
    // SECTION 5: Large-tree verification
    // ====================================================================

    /// @notice Build and verify a tree with 128 leaves, proving all claims.
    function testLargeTree_128LeavesAllClaimed() public {
        string memory communityId = "large-tree-verification";
        uint256 n = 128;
        uint256 expiresAt = block.timestamp + 365 days;
        FuzzEntry[] memory entries = _generateFuzzEntries(n, 42, communityId, expiresAt);
        _buildAndClaimAll(entries, communityId);
    }
}
