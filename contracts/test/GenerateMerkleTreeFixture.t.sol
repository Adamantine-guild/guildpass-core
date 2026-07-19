// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import {MembershipNFT} from "../src/MembershipNFT.sol";
import {GenerateMerkleTree} from "../script/GenerateMerkleTree.s.sol";

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
        nft = new MembershipNFT("GuildPass Membership", "GPM");
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
}
