// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {MembershipNFT} from "../src/MembershipNFT.sol";

contract MembershipNFTTest is Test {
    MembershipNFT nft;
    address admin = address(0x1);
    address owner = address(0x2);
    address alice = address(0xAA);
    address bob = address(0xBB);

    event MembershipMinted(address indexed to, uint256 indexed tokenId, string communityId, uint256 expiresAt);
    event MembershipRenewed(uint256 indexed tokenId, uint256 newExpiresAt);
    event MembershipSuspended(uint256 indexed tokenId, bool isSuspended);

    function setUp() public {
        nft = new MembershipNFT("GuildPass", "GUILD");
        nft.setAdmin(admin, true);
    }

    // ============================================================================
    // MembershipMinted Event Tests
    // ============================================================================

    function test_MembershipMinted_EmitsCorrectEvent() public {
        vm.prank(admin);
        vm.expectEmit(true, true, false, true);
        emit MembershipMinted(alice, 1, "community-dev", block.timestamp + 30 days);
        
        nft.mint(alice, "community-dev", 30 days);
    }

    function test_MembershipMinted_CreatesActiveToken() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 30 days);

        assertTrue(nft.isActive(tokenId));
        assertEq(nft.ownerOf(tokenId), alice);
        assertEq(nft.communityOf(tokenId), "community-dev");
        assertFalse(nft.suspended(tokenId));
    }

    function test_MembershipMinted_SetsCorrectExpiry() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 30 days);

        uint256 expectedExpiry = block.timestamp + 30 days;
        assertEq(nft.expiry(tokenId), expectedExpiry);
    }

    function test_MembershipMinted_MultipleWalletsInCommunity() public {
        vm.prank(admin);
        uint256 tokenId1 = nft.mint(alice, "community-dev", 30 days);
        
        vm.prank(admin);
        uint256 tokenId2 = nft.mint(bob, "community-dev", 30 days);

        assertTrue(nft.isActive(tokenId1));
        assertTrue(nft.isActive(tokenId2));
        assertNotEq(tokenId1, tokenId2);
    }

    function test_MembershipMinted_IncrementsTokenId() public {
        vm.prank(admin);
        uint256 tokenId1 = nft.mint(alice, "community-dev", 30 days);
        
        vm.prank(admin);
        uint256 tokenId2 = nft.mint(bob, "community-dev", 30 days);

        assertEq(tokenId1, 1);
        assertEq(tokenId2, 2);
    }

    function test_MembershipMinted_OverwritesPreviousToken() public {
        vm.prank(admin);
        uint256 tokenId1 = nft.mint(alice, "community-dev", 30 days);
        
        vm.prank(admin);
        uint256 tokenId2 = nft.mint(alice, "community-dev", 60 days);

        // activeTokenOf should point to the new token
        assertEq(nft.activeTokenOf(alice, "community-dev"), tokenId2);
        // But both tokens should exist
        assertTrue(nft.isActive(tokenId1));
        assertTrue(nft.isActive(tokenId2));
    }

    function test_MembershipMinted_RevertIfNotAdmin() public {
        vm.prank(alice); // Not admin
        vm.expectRevert("NOT_ADMIN");
        nft.mint(bob, "community-dev", 30 days);
    }

    // ============================================================================
    // MembershipRenewed Event Tests
    // ============================================================================

    function test_MembershipRenewed_EmitsCorrectEvent() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 5 days);

        uint256 newExpiry = block.timestamp + 30 days;
        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit MembershipRenewed(tokenId, newExpiry);
        
        nft.renew(tokenId, 25 days); // 5 days already passed, extend by 25 more
    }

    function test_MembershipRenewed_ExtendsExpiry() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 5 days);
        
        uint256 expiryBefore = nft.expiry(tokenId);
        
        vm.prank(admin);
        nft.renew(tokenId, 25 days);
        
        uint256 expiryAfter = nft.expiry(tokenId);
        assertGt(expiryAfter, expiryBefore);
    }

    function test_MembershipRenewed_KeepsTokenActive() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 5 days);

        vm.prank(admin);
        nft.renew(tokenId, 30 days);

        assertTrue(nft.isActive(tokenId));
    }

    function test_MembershipRenewed_CanRenewExpiredToken() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 5 days);

        // Fast-forward past expiry
        vm.warp(block.timestamp + 10 days);
        assertFalse(nft.isActive(tokenId));

        // Renew from current timestamp
        vm.prank(admin);
        nft.renew(tokenId, 30 days);

        assertTrue(nft.isActive(tokenId));
    }

    function test_MembershipRenewed_RevertIfNotAdmin() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 30 days);

        vm.prank(alice); // Not admin
        vm.expectRevert("NOT_ADMIN");
        nft.renew(tokenId, 30 days);
    }

    function test_MembershipRenewed_RevertIfTokenNotExists() public {
        vm.prank(admin);
        vm.expectRevert("NO_TOKEN");
        nft.renew(999, 30 days);
    }

    // ============================================================================
    // MembershipSuspended Event Tests
    // ============================================================================

    function test_MembershipSuspended_EmitsCorrectEvent() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 30 days);

        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit MembershipSuspended(tokenId, true);
        
        nft.setSuspended(tokenId, true);
    }

    function test_MembershipSuspended_DeactivatesToken() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 30 days);

        assertTrue(nft.isActive(tokenId));

        vm.prank(admin);
        nft.setSuspended(tokenId, true);

        assertFalse(nft.isActive(tokenId));
        assertTrue(nft.suspended(tokenId));
    }

    function test_MembershipSuspended_CanUnsuspend() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 30 days);

        vm.prank(admin);
        nft.setSuspended(tokenId, true);
        assertFalse(nft.isActive(tokenId));

        vm.prank(admin);
        nft.setSuspended(tokenId, false);
        assertTrue(nft.isActive(tokenId));
    }

    function test_MembershipSuspended_SuspendedTokenStillHasExpiry() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 30 days);

        vm.prank(admin);
        nft.setSuspended(tokenId, true);

        // Should still have expiry recorded
        assertGt(nft.expiry(tokenId), block.timestamp);
    }

    function test_MembershipSuspended_RevertIfNotAdmin() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 30 days);

        vm.prank(alice); // Not admin
        vm.expectRevert("NOT_ADMIN");
        nft.setSuspended(tokenId, true);
    }

    function test_MembershipSuspended_RevertIfTokenNotExists() public {
        vm.prank(admin);
        vm.expectRevert("NO_TOKEN");
        nft.setSuspended(999, true);
    }

    // ============================================================================
    // Integration: Event Sequence Tests
    // ============================================================================

    function test_EventSequence_MintRenewSuspend() public {
        // Mint
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 5 days);
        assertTrue(nft.isActive(tokenId));

        // Renew
        vm.prank(admin);
        nft.renew(tokenId, 30 days);
        assertTrue(nft.isActive(tokenId));

        // Suspend
        vm.prank(admin);
        nft.setSuspended(tokenId, true);
        assertFalse(nft.isActive(tokenId));
    }

    function test_EventSequence_MintSuspendUnsuspendRenew() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 10 days);

        vm.prank(admin);
        nft.setSuspended(tokenId, true);
        assertFalse(nft.isActive(tokenId));

        vm.prank(admin);
        nft.setSuspended(tokenId, false);
        assertTrue(nft.isActive(tokenId));

        vm.warp(block.timestamp + 11 days); // Past original expiry
        assertFalse(nft.isActive(tokenId)); // Now expired

        vm.prank(admin);
        nft.renew(tokenId, 30 days);
        assertTrue(nft.isActive(tokenId)); // Active again
    }

    // ============================================================================
    // Expiry Logic Tests
    // ============================================================================

    function test_Expiry_TokenBecomesInactiveAfterExpiry() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 10 days);

        assertTrue(nft.isActive(tokenId));

        vm.warp(block.timestamp + 11 days);
        assertFalse(nft.isActive(tokenId));
    }

    function test_Expiry_TokenActiveBeforeExpiry() public {
        vm.prank(admin);
        uint256 tokenId = nft.mint(alice, "community-dev", 30 days);

        vm.warp(block.timestamp + 29 days);
        assertTrue(nft.isActive(tokenId));

        vm.warp(block.timestamp + 2 days); // Now past expiry
        assertFalse(nft.isActive(tokenId));
    }
}