// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import "../src/MembershipNFT.sol";

contract MembershipFuzzInvariantTest is Test {
    MembershipNFT nft;
    address admin = address(0xA1);

    function setUp() public {
        nft = new MembershipNFT("GuildPass", "GUILD");
        // msg.sender (this test contract) is the owner, allow admin
        nft.setAdmin(admin, true);
    }

    // Fuzz: minting with varied wallets and expiry values
    function testFuzz_mint(address to, uint256 duration) public {
        vm.assume(to != address(0));
        uint256 dur = (duration % (3650 days)) + 1; // limit and avoid zero

        vm.prank(admin);
        uint256 id = nft.mint(to, "community-fuzz", dur);

        assertEq(nft.ownerOf(id), to);
        assertTrue(nft.isActive(id));
        assertEq(nft.expiry(id), block.timestamp + dur);
        assertEq(nft.activeTokenOf(to, "community-fuzz"), id);
    }

    // Fuzz: renewing should extend expiry
    function testFuzz_renew_extends(address to, uint256 d1, uint256 d2) public {
        vm.assume(to != address(0));
        uint256 dur1 = (d1 % 1000) + 1;
        uint256 dur2 = (d2 % 1000) + 1;

        vm.prank(admin);
        uint256 id = nft.mint(to, "renew-comm", dur1);

        uint256 expiryBefore = nft.expiry(id);
        vm.prank(admin);
        nft.renew(id, dur2);
        uint256 expiryAfter = nft.expiry(id);

        assertGt(expiryAfter, expiryBefore);
        assertTrue(nft.isActive(id));
    }

    // Invariant: each wallet has at most one *simultaneously active* membership
    // token per community. Before the security review fix, re-minting left
    // the previous token still isActive()==true even though activeTokenOf
    // had moved on to the new token — two tokens could be live at once.
    // mint() now suspends the stale token so this can never happen.
    function testInvariant_singleActivePerWalletPerCommunity(address wallet, uint256 d1, uint256 d2)
        public
    {
        vm.assume(wallet != address(0));
        uint256 dur1 = (d1 % 1000) + 1;
        uint256 dur2 = (d2 % 1000) + 1;

        vm.prank(admin);
        uint256 t1 = nft.mint(wallet, "comm-x", dur1);
        vm.prank(admin);
        uint256 t2 = nft.mint(wallet, "comm-x", dur2);

        uint256 active = nft.activeTokenOf(wallet, "comm-x");
        assertEq(active, t2);
        assertTrue(nft.isActive(t2));
        // The invariant that actually matters: t1 must NOT also be active.
        assertFalse(nft.isActive(t1));
    }

    // Suspended memberships cannot be treated as active
    function testSuspendedNotActive() public {
        vm.prank(admin);
        uint256 id = nft.mint(address(0xB), "comm-s", 100);

        vm.prank(admin);
        nft.setSuspended(id, true);

        assertFalse(nft.isActive(id));
        assertTrue(nft.suspended(id));
    }

    // Access control checks
    function testAccessControl_RevertsForNonAdmin(address caller) public {
        vm.assume(caller != address(0));
        vm.assume(caller != admin);

        vm.prank(caller);
        vm.expectRevert("NOT_ADMIN");
        nft.mint(address(0xC), "comm", 10);

        vm.prank(caller);
        vm.expectRevert("NOT_ADMIN");
        nft.renew(1, 10);

        vm.prank(caller);
        vm.expectRevert("NOT_ADMIN");
        nft.setSuspended(1, true);
    }

    // Edge cases: zero addresses and invalid durations
    function testEdgeCases_RevertInvalidInputs() public {
        vm.prank(admin);
        vm.expectRevert("INVALID_TO");
        nft.mint(address(0), "comm", 10);

        vm.prank(admin);
        vm.expectRevert("INVALID_DURATION");
        nft.mint(address(0xD), "comm", 0);

        vm.prank(admin);
        vm.expectRevert("NO_TOKEN");
        nft.renew(9999, 10);
    }

    // Fuzz: only the contract owner may grant/revoke admin, and never to address(0)
    function testFuzz_setAdmin_onlyOwner(address caller, address candidate, bool enabled) public {
        vm.assume(caller != address(this));
        vm.assume(candidate != address(0));

        vm.prank(caller);
        vm.expectRevert("NOT_OWNER");
        nft.setAdmin(candidate, enabled);

        // Owner call succeeds regardless of the fuzzed candidate/enabled value.
        nft.setAdmin(candidate, enabled);
        assertEq(nft.admins(candidate), enabled);
    }

    // Fuzz: ownership transfer only takes effect once the proposed owner accepts
    function testFuzz_transferOwnership_twoStep(address proposedOwner, address rando) public {
        vm.assume(proposedOwner != address(0));
        vm.assume(rando != proposedOwner);

        nft.transferOwnership(proposedOwner);
        assertEq(nft.owner(), address(this));

        vm.prank(rando);
        vm.expectRevert("NOT_PENDING_OWNER");
        nft.acceptOwnership();

        vm.prank(proposedOwner);
        nft.acceptOwnership();
        assertEq(nft.owner(), proposedOwner);
    }

    // Fuzz: expiry boundary is exact — active up to and excluding the expiry timestamp
    function testFuzz_expiryBoundary(uint256 duration) public {
        uint256 dur = (duration % 3650 days) + 1;

        vm.prank(admin);
        uint256 id = nft.mint(address(0xE), "comm-boundary", dur);
        uint256 expiresAt = nft.expiry(id);

        vm.warp(expiresAt - 1);
        assertTrue(nft.isActive(id));

        vm.warp(expiresAt);
        assertFalse(nft.isActive(id));
    }
}
