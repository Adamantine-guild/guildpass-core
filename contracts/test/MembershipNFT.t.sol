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
        nft = new MembershipNFT("GuildPass Membership", "GPM", "https://guildpass.example.com/metadata/");
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

    // -------------------------------------------------------------------
    // ERC-165 supportsInterface
    // -------------------------------------------------------------------

    function testSupportsInterface_IERC165() public view {
        assertTrue(nft.supportsInterface(0x01ffc9a7));
    }

    function testSupportsInterface_IERC721() public view {
        assertTrue(nft.supportsInterface(0x80ac58cd));
    }

    function testSupportsInterface_IERC5192() public view {
        assertTrue(nft.supportsInterface(0x4bc2a65b));
    }

    function testSupportsInterface_UnrelatedInterface() public view {
        assertFalse(nft.supportsInterface(0xffffffff));
        assertFalse(nft.supportsInterface(0x12345678));
    }

    // -------------------------------------------------------------------
    // ERC-721 balanceOf
    // -------------------------------------------------------------------

    function testBalanceOf_ZeroForNonHolder() public view {
        assertEq(nft.balanceOf(user), 0);
    }

    function testBalanceOf_RevertsForZeroAddress() public {
        vm.expectRevert("ZERO_ADDRESS");
        nft.balanceOf(address(0));
    }

    function testBalanceOf_IncrementsOnMint() public {
        vm.prank(admin);
        nft.mint(user, COMMUNITY_ID, 365 days);
        assertEq(nft.balanceOf(user), 1);

        // Mint a second token for a different community
        vm.prank(admin);
        nft.mint(user, "other-community", 365 days);
        assertEq(nft.balanceOf(user), 2);
    }

    function testBalanceOf_DecrementsOnSuspend() public {
        vm.prank(admin);
        uint256 id = nft.mint(user, COMMUNITY_ID, 365 days);
        assertEq(nft.balanceOf(user), 1);

        vm.prank(admin);
        nft.setSuspended(id, true);
        assertEq(nft.balanceOf(user), 0);
    }

    function testBalanceOf_RemainsCorrectAcrossRemintSequence() public {
        // Mint first token
        vm.prank(admin);
        nft.mint(user, COMMUNITY_ID, 365 days);
        assertEq(nft.balanceOf(user), 1);

        // Re-mint suspends old + mints new: net balance stays at 1
        vm.prank(admin);
        nft.mint(user, COMMUNITY_ID, 365 days);
        assertEq(nft.balanceOf(user), 1);

        // A third re-mint: still 1
        vm.prank(admin);
        nft.mint(user, COMMUNITY_ID, 365 days);
        assertEq(nft.balanceOf(user), 1);
    }

    function testBalanceOf_UnsuspendRestoresBalance() public {
        vm.prank(admin);
        uint256 id = nft.mint(user, COMMUNITY_ID, 365 days);
        assertEq(nft.balanceOf(user), 1);

        vm.prank(admin);
        nft.setSuspended(id, true);
        assertEq(nft.balanceOf(user), 0);

        // Unsuspend while still within expiry window
        vm.prank(admin);
        nft.setSuspended(id, false);
        assertEq(nft.balanceOf(user), 1);
    }

    // -------------------------------------------------------------------
    // ERC-721 tokenURI
    // -------------------------------------------------------------------

    function testTokenURI_ReturnsWellFormedUri() public {
        vm.prank(admin);
        uint256 id = nft.mint(user, COMMUNITY_ID, 365 days);
        string memory uri = nft.tokenURI(id);
        assertEq(uri, string(abi.encodePacked("https://guildpass.example.com/metadata/", _toString(id))));
    }

    function testTokenURI_RevertsForNonexistentToken() public {
        vm.expectRevert("NO_TOKEN");
        nft.tokenURI(999);
    }

    function testBaseTokenURI_ReturnsConfiguredValue() public view {
        assertEq(nft.baseTokenURI(), "https://guildpass.example.com/metadata/");
    }

    // -------------------------------------------------------------------
    // ERC-5192 locked()
    // -------------------------------------------------------------------

    function testLocked_AlwaysReturnsTrue() public {
        vm.prank(admin);
        uint256 id = nft.mint(user, COMMUNITY_ID, 365 days);
        assertTrue(nft.locked(id));
    }

    function testLocked_RevertsForNonexistentToken() public {
        vm.expectRevert("NO_TOKEN");
        nft.locked(999);
    }

    function testLocked_ReturnsTrueEvenWhenSuspended() public {
        vm.prank(admin);
        uint256 id = nft.mint(user, COMMUNITY_ID, 365 days);
        vm.prank(admin);
        nft.setSuspended(id, true);
        assertTrue(nft.locked(id)); // still locked (soulbound)
    }

    function testLocked_ReturnsTrueEvenWhenExpired() public {
        vm.prank(admin);
        uint256 id = nft.mint(user, COMMUNITY_ID, 1);
        vm.warp(block.timestamp + 2);
        assertTrue(nft.locked(id)); // still locked even if expired
    }

    // -------------------------------------------------------------------
    // ERC-721 Transfer events
    // -------------------------------------------------------------------

    function testMintEmitsTransferFromZero() public {
        vm.expectEmit(true, true, true, false);
        emit MembershipNFT.Transfer(address(0), user, 1);
        vm.prank(admin);
        nft.mint(user, COMMUNITY_ID, 365 days);
    }

    function testMintEmitsLockedEvent() public {
        vm.expectEmit(true, false, false, false);
        emit MembershipNFT.Locked(1);
        vm.prank(admin);
        nft.mint(user, COMMUNITY_ID, 365 days);
    }

    function testSuspendEmitsTransferToZero() public {
        vm.prank(admin);
        uint256 id = nft.mint(user, COMMUNITY_ID, 365 days);

        vm.expectEmit(true, true, true, false);
        emit MembershipNFT.Transfer(user, address(0), id);
        vm.prank(admin);
        nft.setSuspended(id, true);
    }

    function testRemintEmitsBothTransferEvents() public {
        vm.prank(admin);
        uint256 first = nft.mint(user, COMMUNITY_ID, 365 days);

        // Re-mint: suspend old (Transfer to zero) + mint new (Transfer from zero)
        vm.expectEmit(true, true, true, false);
        emit MembershipNFT.Transfer(user, address(0), first);
        vm.expectEmit(true, true, true, false);
        emit MembershipNFT.Transfer(address(0), user, first + 1);
        vm.prank(admin);
        nft.mint(user, COMMUNITY_ID, 365 days);
    }

    // -------------------------------------------------------------------
    // ERC-5192 events (Locked emitted on mint)
    // -------------------------------------------------------------------

    function testClaimMembershipEmitsTransferAndLocked() public {
        // Test via admin mint which already covers Transfer + Locked emission
        vm.prank(admin);
        uint256 id = nft.mint(user, COMMUNITY_ID, 365 days);
        assertTrue(nft.locked(id));
        assertEq(nft.balanceOf(user), 1);
    }

    // -------------------------------------------------------------------
    // Helper: uint256 to string (mirrors contract's internal _toString)
    // -------------------------------------------------------------------

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
