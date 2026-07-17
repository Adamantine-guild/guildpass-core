// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import "../src/MembershipNFT.sol";

contract MembershipNFTTest is Test {
    MembershipNFT nft;
    address admin = address(0xA11CE);
    address user = address(0xBEEF);
    string constant COMMUNITY_ID = "test-community";

    function setUp() public {
        nft = new MembershipNFT("GuildPass Membership", "GPM");
        nft.setAdmin(admin, true);
    }

    function testMintAndActive() public {
        vm.prank(admin);
        uint256 id = nft.mint(user, COMMUNITY_ID, 365 days);
        assertTrue(nft.isActive(id));
        assertEq(nft.communityOf(id), COMMUNITY_ID);
        assertEq(nft.activeTokenOf(user, COMMUNITY_ID), id);
    }

    function testRenew() public {
        vm.prank(admin);
        uint256 id = nft.mint(user, COMMUNITY_ID, 1);
        vm.warp(block.timestamp + 2);
        assertFalse(nft.isActive(id));
        vm.prank(admin);
        nft.renew(id, 100);
        assertTrue(nft.isActive(id));
    }

    function testSuspend() public {
        vm.prank(admin);
        uint256 id = nft.mint(user, COMMUNITY_ID, 100);
        vm.prank(admin);
        nft.setSuspended(id, true);
        assertFalse(nft.isActive(id));
    }

    // --- Security review regression tests ---
    // See contracts/SECURITY_REVIEW_MembershipNFT.md for the full findings.

    function testSetAdminEmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit MembershipNFT.AdminUpdated(address(0xCAFE), true);
        nft.setAdmin(address(0xCAFE), true);
    }

    function testSetAdminRejectsZeroAddress() public {
        vm.expectRevert("INVALID_ADMIN");
        nft.setAdmin(address(0), true);
    }

    function testReMintingSuspendsThePreviousActiveToken() public {
        vm.prank(admin);
        uint256 first = nft.mint(user, COMMUNITY_ID, 100);
        assertTrue(nft.isActive(first));

        vm.prank(admin);
        uint256 second = nft.mint(user, COMMUNITY_ID, 100);

        // The invariant "at most one active membership per wallet per
        // community" must hold on-chain, not just in the activeTokenOf
        // pointer: the stale token is suspended, not merely un-pointed-to.
        assertFalse(nft.isActive(first));
        assertTrue(nft.suspended(first));
        assertTrue(nft.isActive(second));
        assertEq(nft.activeTokenOf(user, COMMUNITY_ID), second);
    }

    function testReMintingAfterExpiryDoesNotEmitRedundantSuspend() public {
        vm.prank(admin);
        uint256 first = nft.mint(user, COMMUNITY_ID, 1);
        vm.warp(block.timestamp + 2);
        assertFalse(nft.isActive(first)); // expired, not suspended

        vm.prank(admin);
        uint256 second = nft.mint(user, COMMUNITY_ID, 100);
        assertFalse(nft.suspended(first)); // still just expired, never marked suspended
        assertTrue(nft.isActive(second));
    }

    function testTransferOwnershipRequiresAcceptance() public {
        address newOwner = address(0xD00D);
        nft.transferOwnership(newOwner);
        assertEq(nft.owner(), address(this)); // unchanged until accepted
        assertEq(nft.pendingOwner(), newOwner);

        vm.prank(newOwner);
        nft.acceptOwnership();
        assertEq(nft.owner(), newOwner);
        assertEq(nft.pendingOwner(), address(0));
    }

    function testAcceptOwnershipRevertsForNonPendingOwner() public {
        nft.transferOwnership(address(0xD00D));
        vm.expectRevert("NOT_PENDING_OWNER");
        vm.prank(address(0xBAD));
        nft.acceptOwnership();
    }

    function testTransferOwnershipRejectsZeroAddress() public {
        vm.expectRevert("INVALID_OWNER");
        nft.transferOwnership(address(0));
    }

    function testExpiryBoundary() public {
        vm.prank(admin);
        uint256 id = nft.mint(user, COMMUNITY_ID, 100);
        uint256 expiresAt = nft.expiry(id);

        vm.warp(expiresAt - 1);
        assertTrue(nft.isActive(id)); // one second before expiry: still active

        vm.warp(expiresAt);
        assertFalse(nft.isActive(id)); // at the exact expiry timestamp: expired
    }
}
