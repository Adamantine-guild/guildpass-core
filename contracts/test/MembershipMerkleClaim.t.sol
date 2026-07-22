// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import {MembershipNFT} from "../src/MembershipNFT.sol";
import {MerkleTreeLib} from "../script/MerkleTreeLib.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice Tests for the Merkle-based batch mint/renew claim path added to
/// MembershipNFT for issue #102. Covers the acceptance criteria (valid claim,
/// invalid proof, double-claim rejection) plus the adjacent modes agreed on
/// during design: root rotation, relayer submission, second-preimage
/// resistance, mint-vs-renew divergence, and event-ordering/indexer
/// compatibility.
contract MembershipMerkleClaimTest is Test {
    MembershipNFT nft;
    address admin = address(0xA11CE);
    string constant COMMUNITY_A = "merkle-community-a";
    string constant COMMUNITY_B = "merkle-community-b";

    struct Entry {
        uint256 index;
        address wallet;
        string communityId;
        uint256 expiresAt;
    }

    // Event signatures, precomputed so vm.getRecordedLogs() results can be
    // matched by topic0 to prove exact emission order.
    bytes32 constant MINTED_SIG = keccak256("MembershipMinted(address,uint256,string,uint256)");
    bytes32 constant RENEWED_SIG = keccak256("MembershipRenewed(uint256,uint256)");
    bytes32 constant CLAIMED_SIG =
        keccak256("MembershipClaimed(address,uint256,string,uint256,uint256)");
    bytes32 constant TRANSFER_SIG = keccak256("Transfer(address,address,uint256)");
    bytes32 constant LOCKED_SIG = keccak256("Locked(uint256)");

    function setUp() public {
        nft = new MembershipNFT("GuildPass Membership", "GPM", "https://guildpass.example.com/metadata/");
        nft.setAdmin(admin, true);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _leaves(Entry[] memory entries) internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](entries.length);
        for (uint256 i = 0; i < entries.length; i++) {
            leaves[i] = MerkleTreeLib.leafHash(
                entries[i].index, entries[i].wallet, entries[i].communityId, entries[i].expiresAt
            );
        }
    }

    function _sampleEntries(string memory communityId, uint256 count, uint256 walletSeed)
        internal
        view
        returns (Entry[] memory entries)
    {
        entries = new Entry[](count);
        for (uint256 i = 0; i < count; i++) {
            entries[i] = Entry({
                index: i,
                wallet: address(uint160(uint256(keccak256(abi.encode(walletSeed, i))) | 1)),
                communityId: communityId,
                expiresAt: block.timestamp + 365 days
            });
        }
    }

    function _tree(Entry[] memory entries)
        internal
        pure
        returns (bytes32[][] memory levels, bytes32 root)
    {
        levels = MerkleTreeLib.buildLevels(_leaves(entries));
        root = MerkleTreeLib.root(levels);
    }

    function _setRoot(string memory communityId, bytes32 root) internal {
        vm.prank(admin);
        nft.setMembershipMerkleRoot(communityId, root);
    }

    // ---------------------------------------------------------------------
    // 1. Valid claim mints / renews
    // ---------------------------------------------------------------------

    function testClaim_MintsForNewWallet() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 4, 1);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 1);
        uint256 tokenId =
            nft.claimMembership(COMMUNITY_A, 1, entries[1].wallet, entries[1].expiresAt, proof);

        assertTrue(nft.isActive(tokenId));
        assertEq(nft.ownerOf(tokenId), entries[1].wallet);
        assertEq(nft.expiry(tokenId), entries[1].expiresAt);
        assertEq(nft.activeTokenOf(entries[1].wallet, COMMUNITY_A), tokenId);
        assertTrue(nft.isClaimed(COMMUNITY_A, root, 1));
    }

    function testClaim_RenewsForExistingWallet_KeepsSameTokenId() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 4, 2);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        // First claim mints.
        bytes32[] memory proof0 = MerkleTreeLib.proofFor(levels, 0);
        uint256 firstTokenId =
            nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof0);

        // A second Merkle root (fresh entries, same wallet, later expiry) is
        // published later - simulating a subsequent renewal snapshot.
        Entry[] memory laterEntries = new Entry[](1);
        laterEntries[0] = Entry({
            index: 0,
            wallet: entries[0].wallet,
            communityId: COMMUNITY_A,
            expiresAt: entries[0].expiresAt + 30 days
        });
        (bytes32[][] memory laterLevels, bytes32 laterRoot) = _tree(laterEntries);
        _setRoot(COMMUNITY_A, laterRoot);

        bytes32[] memory laterProof = MerkleTreeLib.proofFor(laterLevels, 0);
        uint256 secondTokenId = nft.claimMembership(
            COMMUNITY_A, 0, laterEntries[0].wallet, laterEntries[0].expiresAt, laterProof
        );

        assertEq(secondTokenId, firstTokenId, "renewal must reuse the same tokenId");
        assertEq(nft.expiry(firstTokenId), laterEntries[0].expiresAt);
        assertEq(nft.activeTokenOf(entries[0].wallet, COMMUNITY_A), firstTokenId);
    }

    /// @dev Note 1 from the maintainer: the claim-renewal / admin-mint
    /// divergence must be pinned by a test, not left as incidental behavior.
    /// A Merkle claim for a wallet that already holds a token reuses that
    /// SAME tokenId, while an admin mint() for that same wallet+community
    /// always mints a fresh tokenId (and suspends the previous one). Both
    /// behaviors are asserted here side by side.
    function testDivergence_ClaimRenewalKeepsTokenId_AdminMintCreatesNew() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 1, 3);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 0);
        uint256 claimedTokenId =
            nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof);

        // Claim again (new root, later expiry) - must reuse the same tokenId.
        Entry[] memory renewEntries = new Entry[](1);
        renewEntries[0] = Entry({
            index: 0,
            wallet: entries[0].wallet,
            communityId: COMMUNITY_A,
            expiresAt: entries[0].expiresAt + 1 days
        });
        (bytes32[][] memory renewLevels, bytes32 renewRoot) = _tree(renewEntries);
        _setRoot(COMMUNITY_A, renewRoot);
        bytes32[] memory renewProof = MerkleTreeLib.proofFor(renewLevels, 0);
        uint256 renewedTokenId = nft.claimMembership(
            COMMUNITY_A, 0, renewEntries[0].wallet, renewEntries[0].expiresAt, renewProof
        );
        assertEq(renewedTokenId, claimedTokenId, "claim path must renew in place");

        // Admin mint() for the SAME wallet+community mints a fresh tokenId
        // and suspends the previously active one - existing, unmodified
        // mint() behavior, deliberately different from the claim path.
        vm.prank(admin);
        uint256 adminMintedTokenId = nft.mint(entries[0].wallet, COMMUNITY_A, 100 days);

        assertTrue(adminMintedTokenId != claimedTokenId, "admin mint() must create a new tokenId");
        assertTrue(
            nft.suspended(claimedTokenId), "admin mint() must suspend the prior active token"
        );
        assertTrue(nft.isActive(adminMintedTokenId));
        assertEq(nft.activeTokenOf(entries[0].wallet, COMMUNITY_A), adminMintedTokenId);
    }

    function testClaim_RenewalDoesNotClearSuspension() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 1, 4);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 0);
        uint256 tokenId =
            nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof);

        vm.prank(admin);
        nft.setSuspended(tokenId, true);
        assertFalse(nft.isActive(tokenId));

        Entry[] memory renewEntries = new Entry[](1);
        renewEntries[0] = Entry({
            index: 0,
            wallet: entries[0].wallet,
            communityId: COMMUNITY_A,
            expiresAt: entries[0].expiresAt + 1 days
        });
        (bytes32[][] memory renewLevels, bytes32 renewRoot) = _tree(renewEntries);
        _setRoot(COMMUNITY_A, renewRoot);
        bytes32[] memory renewProof = MerkleTreeLib.proofFor(renewLevels, 0);
        nft.claimMembership(
            COMMUNITY_A, 0, renewEntries[0].wallet, renewEntries[0].expiresAt, renewProof
        );

        // Expiry moved forward, but suspension - exactly like renew() -
        // is untouched: only setSuspended can lift it.
        assertEq(nft.expiry(tokenId), renewEntries[0].expiresAt);
        assertTrue(nft.suspended(tokenId));
        assertFalse(nft.isActive(tokenId));
    }

    // ---------------------------------------------------------------------
    // 2. Invalid proof variants
    // ---------------------------------------------------------------------

    function testClaim_RevertsWrongProof() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 4, 5);
        (, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        bytes32[] memory garbageProof = new bytes32[](2);
        garbageProof[0] = keccak256("garbage-0");
        garbageProof[1] = keccak256("garbage-1");

        vm.expectRevert("INVALID_PROOF");
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, garbageProof);
    }

    function testClaim_RevertsForTamperedIndex() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 4, 6);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 1);
        // proof for index 1's leaf, submitted claiming to be index 2.
        vm.expectRevert("INVALID_PROOF");
        nft.claimMembership(COMMUNITY_A, 2, entries[1].wallet, entries[1].expiresAt, proof);
    }

    function testClaim_RevertsTamperedExpiry() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 4, 7);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 0);
        vm.expectRevert("INVALID_PROOF");
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt + 1, proof);
    }

    function testClaim_RevertsTamperedWallet() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 4, 8);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 0);
        address attacker = address(0xBAD);
        vm.expectRevert("INVALID_PROOF");
        nft.claimMembership(COMMUNITY_A, 0, attacker, entries[0].expiresAt, proof);
    }

    function testClaim_RevertsEmptyProof() public {
        // A tree with >1 leaf so the leaf itself is never equal to the root.
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 4, 9);
        (, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        bytes32[] memory emptyProof = new bytes32[](0);
        vm.expectRevert("INVALID_PROOF");
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, emptyProof);
    }

    function testClaim_RevertsProofFromDifferentCommunityRoot() public {
        Entry[] memory entriesA = _sampleEntries(COMMUNITY_A, 4, 10);
        (bytes32[][] memory levelsA, bytes32 rootA) = _tree(entriesA);
        _setRoot(COMMUNITY_A, rootA);

        Entry[] memory entriesB = _sampleEntries(COMMUNITY_B, 4, 10);
        (, bytes32 rootB) = _tree(entriesB);
        _setRoot(COMMUNITY_B, rootB);

        // Valid proof under community A's root, submitted against community B.
        bytes32[] memory proofA = MerkleTreeLib.proofFor(levelsA, 0);
        vm.expectRevert("INVALID_PROOF");
        nft.claimMembership(COMMUNITY_B, 0, entriesA[0].wallet, entriesA[0].expiresAt, proofA);
    }

    // ---------------------------------------------------------------------
    // 3. Replay protection / access control / validation
    // ---------------------------------------------------------------------

    function testClaim_RevertsDoubleClaim() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 4, 11);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 0);
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof);

        vm.expectRevert("ALREADY_CLAIMED");
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof);
    }

    function testClaim_RevertsExpiredExpiry() public {
        Entry[] memory entries = new Entry[](2);
        entries[0] = Entry({
            index: 0,
            wallet: address(0x1111),
            communityId: COMMUNITY_A,
            expiresAt: block.timestamp + 1
        });
        entries[1] = Entry({
            index: 1,
            wallet: address(0x2222),
            communityId: COMMUNITY_A,
            expiresAt: block.timestamp + 2 days
        });
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        vm.warp(block.timestamp + 2);
        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 0);
        vm.expectRevert("EXPIRY_IN_PAST");
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof);
    }

    function testSetMerkleRoot_RevertsForNonAdmin() public {
        vm.expectRevert("NOT_ADMIN");
        nft.setMembershipMerkleRoot(COMMUNITY_A, keccak256("root"));
    }

    function testSetMerkleRoot_RevertsZeroRoot() public {
        vm.prank(admin);
        vm.expectRevert("INVALID_ROOT");
        nft.setMembershipMerkleRoot(COMMUNITY_A, bytes32(0));
    }

    function testSetMerkleRoot_EmitsPreviousAndNewRoot() public {
        bytes32 rootOne = keccak256("root-one");
        bytes32 rootTwo = keccak256("root-two");

        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit MembershipNFT.MembershipMerkleRootUpdated(COMMUNITY_A, bytes32(0), rootOne);
        nft.setMembershipMerkleRoot(COMMUNITY_A, rootOne);

        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit MembershipNFT.MembershipMerkleRootUpdated(COMMUNITY_A, rootOne, rootTwo);
        nft.setMembershipMerkleRoot(COMMUNITY_A, rootTwo);
    }

    function testClaim_RevertsWhenNoRootSet() public {
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert("NO_ROOT_SET");
        nft.claimMembership(COMMUNITY_A, 0, address(0x1234), block.timestamp + 1 days, proof);
    }

    function testClaim_RevertsInvalidWallet() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 2, 12);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 0);
        vm.expectRevert("INVALID_WALLET");
        nft.claimMembership(COMMUNITY_A, 0, address(0), entries[0].expiresAt, proof);
    }

    // ---------------------------------------------------------------------
    // 4. Root rotation semantics
    // ---------------------------------------------------------------------

    function testRootRotation_OldProofRejectedUnderNewRoot() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 4, 13);
        (bytes32[][] memory levels, bytes32 oldRoot) = _tree(entries);
        _setRoot(COMMUNITY_A, oldRoot);

        bytes32 newRoot = keccak256("unrelated-new-root");
        _setRoot(COMMUNITY_A, newRoot);

        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 0);
        vm.expectRevert("INVALID_PROOF");
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof);
    }

    /// @dev Note 2 from the maintainer: prove the EXACT scenario
    /// EXPIRY_NOT_LATER exists for - a leaf that was valid and already
    /// claimed (or otherwise stale relative to current expiry) gets
    /// replayed under a freshly rotated root and must fail loudly.
    function testRootRotation_StaleLeafReplayRevertsExpiryNotLater() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 1, 14);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 0);
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof);

        // Admin renews the wallet directly to a LATER expiry than the
        // original tree committed to (e.g. a manual override).
        uint256 tokenId = nft.activeTokenOf(entries[0].wallet, COMMUNITY_A);
        vm.prank(admin);
        nft.renew(tokenId, 400 days);
        uint256 expiryAfterAdminRenew = nft.expiry(tokenId);

        // A NEW root is rotated in whose leaf for this same wallet commits to
        // the OLD (now-stale) expiry - e.g. a rollback to a prior snapshot.
        // A second, unrelated padding entry is included so this tree's root
        // is genuinely different from the original (a single-leaf tree with
        // an identical leaf would reproduce the SAME root, which would hit
        // ALREADY_CLAIMED instead of exercising the forward-only check this
        // test targets).
        Entry[] memory staleEntries = new Entry[](2);
        staleEntries[0] = Entry({
            index: 0,
            wallet: entries[0].wallet,
            communityId: COMMUNITY_A,
            expiresAt: entries[0].expiresAt
        });
        staleEntries[1] = Entry({
            index: 1,
            wallet: address(0x9999),
            communityId: COMMUNITY_A,
            expiresAt: block.timestamp + 1 days
        });
        (bytes32[][] memory staleLevels, bytes32 staleRoot) = _tree(staleEntries);
        _setRoot(COMMUNITY_A, staleRoot);

        bytes32[] memory staleProof = MerkleTreeLib.proofFor(staleLevels, 0);
        vm.expectRevert("EXPIRY_NOT_LATER");
        nft.claimMembership(
            COMMUNITY_A, 0, staleEntries[0].wallet, staleEntries[0].expiresAt, staleProof
        );

        // State must be unchanged by the reverted attempt.
        assertEq(nft.expiry(tokenId), expiryAfterAdminRenew);
    }

    function testRootRotation_ClaimStateIsolatedPerRoot() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 2, 15);
        (bytes32[][] memory levels, bytes32 rootOne) = _tree(entries);
        _setRoot(COMMUNITY_A, rootOne);

        bytes32[] memory proof0 = MerkleTreeLib.proofFor(levels, 0);
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof0);
        assertTrue(nft.isClaimed(COMMUNITY_A, rootOne, 0));

        // Rotate to a genuinely different root containing a DIFFERENT wallet
        // at index 0 - the bitmap for the new root must start fresh, i.e.
        // index 0 must be claimable again under this new root.
        Entry[] memory freshEntries = _sampleEntries(COMMUNITY_A, 2, 999);
        (bytes32[][] memory freshLevels, bytes32 rootTwo) = _tree(freshEntries);
        _setRoot(COMMUNITY_A, rootTwo);

        assertFalse(nft.isClaimed(COMMUNITY_A, rootTwo, 0));
        bytes32[] memory freshProof0 = MerkleTreeLib.proofFor(freshLevels, 0);
        nft.claimMembership(
            COMMUNITY_A, 0, freshEntries[0].wallet, freshEntries[0].expiresAt, freshProof0
        );

        // The OLD root's claim record is untouched by the rotation.
        assertTrue(nft.isClaimed(COMMUNITY_A, rootOne, 0));
    }

    function testRootRotation_RepublishingSameRootPreservesClaimState() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 2, 16);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        bytes32[] memory proof0 = MerkleTreeLib.proofFor(levels, 0);
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof0);

        // Re-publish the IDENTICAL root value.
        _setRoot(COMMUNITY_A, root);

        // Index 0 remains claimed - same tree, same bitmap key, unsurprising.
        assertTrue(nft.isClaimed(COMMUNITY_A, root, 0));
        vm.expectRevert("ALREADY_CLAIMED");
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof0);

        // Index 1, never claimed, is still claimable after the re-publish.
        bytes32[] memory proof1 = MerkleTreeLib.proofFor(levels, 1);
        nft.claimMembership(COMMUNITY_A, 1, entries[1].wallet, entries[1].expiresAt, proof1);
        assertTrue(nft.isClaimed(COMMUNITY_A, root, 1));
    }

    // ---------------------------------------------------------------------
    // 5. Relayer path
    // ---------------------------------------------------------------------

    function testClaim_RelayerSubmitsOnBehalfOfWallet() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 4, 17);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        address relayer = address(0xFEE);
        assertTrue(relayer != entries[2].wallet);

        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 2);
        vm.prank(relayer);
        uint256 tokenId =
            nft.claimMembership(COMMUNITY_A, 2, entries[2].wallet, entries[2].expiresAt, proof);

        // Membership lands with the leaf's wallet, never msg.sender.
        assertEq(nft.ownerOf(tokenId), entries[2].wallet);
        assertTrue(nft.ownerOf(tokenId) != relayer);
        assertEq(nft.activeTokenOf(entries[2].wallet, COMMUNITY_A), tokenId);
        assertEq(nft.activeTokenOf(relayer, COMMUNITY_A), 0);
    }

    // ---------------------------------------------------------------------
    // 6. Second-preimage resistance
    // ---------------------------------------------------------------------

    /// @dev Justifies the double keccak256 in the leaf encoding. Builds a real
    /// 4-leaf tree, then attempts to use an INTERNAL node (the hash combining
    /// leaves[0] and leaves[1], which an observer of the published leaves can
    /// freely compute) as if it were itself a valid leaf, using the sibling
    /// internal node as a one-element "proof". The `assertTrue` below shows
    /// this forged pair WOULD verify against the real root under OZ
    /// MerkleProof's raw verify() - i.e. the attack is real against a
    /// single-hashed leaf scheme. claimMembership never accepts a raw leaf
    /// value, though: it only derives one from (index, wallet, communityId,
    /// expiresAt) via keccak256(bytes.concat(keccak256(abi.encode(...)))),
    /// which hashes exactly 32 bytes as its outer step, structurally distinct
    /// from hashPair's 64-byte input - so no choice of those four parameters
    /// reproduces the internal node's value short of an actual hash
    /// collision, and the attempt reverts.
    function testSecondPreimage_InternalNodeCannotBeUsedAsLeaf() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 4, 18);
        bytes32[] memory leaves = _leaves(entries);
        bytes32[][] memory levels = MerkleTreeLib.buildLevels(leaves);
        bytes32 root = MerkleTreeLib.root(levels);
        _setRoot(COMMUNITY_A, root);

        bytes32 internalNode01 = MerkleTreeLib.hashPair(leaves[0], leaves[1]);
        bytes32 siblingNode23 = levels[1][1];
        bytes32[] memory forgedProof = new bytes32[](1);
        forgedProof[0] = siblingNode23;

        // The vulnerability this test guards against: a raw-leaf verifier
        // WOULD accept this forged pair.
        assertTrue(MerkleProof.verify(forgedProof, root, internalNode01));

        // claimMembership structurally cannot be fed `internalNode01`
        // directly - any (index, wallet, communityId, expiresAt) choice
        // recomputes a double-hashed leaf that cannot equal it.
        address attacker = address(0xE41);
        vm.expectRevert("INVALID_PROOF");
        nft.claimMembership(COMMUNITY_A, 0, attacker, block.timestamp + 1 days, forgedProof);
    }

    // ---------------------------------------------------------------------
    // 7. Event ordering / indexer compatibility (note 4)
    // ---------------------------------------------------------------------

    function testClaim_EventOrder_MintPath() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 4, 19);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);
        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 0);

        vm.recordLogs();
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // Mint path now emits 4 events: Transfer + Locked + Minted + Claimed
        // (Transfer and Locked are additive ERC-721/ERC-5192 compliance events)
        assertEq(logs.length, 4, "mint path must emit Transfer + Locked + Minted + Claimed");
        assertEq(logs[0].topics[0], TRANSFER_SIG, "Transfer must fire first");
        assertEq(logs[1].topics[0], LOCKED_SIG, "Locked must fire second");
        assertEq(logs[2].topics[0], MINTED_SIG, "MembershipMinted must fire third");
        assertEq(logs[3].topics[0], CLAIMED_SIG, "MembershipClaimed must fire fourth");
    }

    function testClaim_EventOrder_RenewPath() public {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 1, 20);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);
        bytes32[] memory proof = MerkleTreeLib.proofFor(levels, 0);
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, proof);

        Entry[] memory renewEntries = new Entry[](1);
        renewEntries[0] = Entry({
            index: 0,
            wallet: entries[0].wallet,
            communityId: COMMUNITY_A,
            expiresAt: entries[0].expiresAt + 1 days
        });
        (bytes32[][] memory renewLevels, bytes32 renewRoot) = _tree(renewEntries);
        _setRoot(COMMUNITY_A, renewRoot);
        bytes32[] memory renewProof = MerkleTreeLib.proofFor(renewLevels, 0);

        vm.recordLogs();
        nft.claimMembership(
            COMMUNITY_A, 0, renewEntries[0].wallet, renewEntries[0].expiresAt, renewProof
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 2, "renew path must emit exactly Renewed + Claimed");
        assertEq(logs[0].topics[0], RENEWED_SIG, "MembershipRenewed must fire first");
        assertEq(logs[1].topics[0], CLAIMED_SIG, "MembershipClaimed must fire second");
    }

    // ---------------------------------------------------------------------
    // 8. Fuzz
    // ---------------------------------------------------------------------

    function testFuzz_EachLeafClaimsExactlyOnce(
        uint8 rawCount,
        uint256 walletSeed,
        uint8 rawClaimOrder
    ) public {
        uint256 count = bound(uint256(rawCount), 2, 20);
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, count, walletSeed);
        (bytes32[][] memory levels, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        for (uint256 i = 0; i < count; i++) {
            bytes32[] memory proof = MerkleTreeLib.proofFor(levels, i);
            uint256 tokenId =
                nft.claimMembership(COMMUNITY_A, i, entries[i].wallet, entries[i].expiresAt, proof);
            assertTrue(nft.isActive(tokenId));
            assertEq(nft.ownerOf(tokenId), entries[i].wallet);
        }

        // Re-claiming a fuzzed-but-valid index must revert - every leaf
        // claims exactly once.
        uint256 replayIndex = bound(uint256(rawClaimOrder), 0, count - 1);
        bytes32[] memory replayProof = MerkleTreeLib.proofFor(levels, replayIndex);
        vm.expectRevert("ALREADY_CLAIMED");
        nft.claimMembership(
            COMMUNITY_A,
            replayIndex,
            entries[replayIndex].wallet,
            entries[replayIndex].expiresAt,
            replayProof
        );
    }

    function testFuzz_InvalidProofAlwaysReverts(bytes32 g0, bytes32 g1, bytes32 g2, uint8 rawLen)
        public
    {
        Entry[] memory entries = _sampleEntries(COMMUNITY_A, 8, 21);
        (, bytes32 root) = _tree(entries);
        _setRoot(COMMUNITY_A, root);

        uint256 len = bound(uint256(rawLen), 0, 3);
        bytes32[] memory garbage = new bytes32[](len);
        if (len > 0) garbage[0] = g0;
        if (len > 1) garbage[1] = g1;
        if (len > 2) garbage[2] = g2;

        vm.expectRevert("INVALID_PROOF");
        nft.claimMembership(COMMUNITY_A, 0, entries[0].wallet, entries[0].expiresAt, garbage);
    }
}
