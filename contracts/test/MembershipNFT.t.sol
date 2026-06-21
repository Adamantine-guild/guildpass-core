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
}
