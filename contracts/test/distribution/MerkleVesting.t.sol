// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test, console} from "forge-std/Test.sol";
import {MerkleVesting} from "../../src/distribution/MerkleVesting.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock Token", "MCK") {
        _mint(msg.sender, 1_000_000_000 * 1e18);
    }
}

contract MerkleVestingTest is Test {
    MerkleVesting public vesting;
    MockToken public token;

    address public alice = address(0x1111111111111111111111111111111111111111);
    address public bob   = address(0x2222222222222222222222222222222222222222);

    uint256 public constant ALICE_ALLOCATION = 1_000_000 * 1e18; // 1M tokens
    uint256 public constant ALICE_DURATION   = 365 days;

    uint256 public constant BOB_ALLOCATION   = 500_000 * 1e18;   // 500k tokens
    uint256 public constant BOB_DURATION     = 180 days;

    uint256 public startTimestamp;

    bytes32 public aliceLeaf;
    bytes32 public bobLeaf;
    bytes32 public merkleRoot;

    bytes32[] public aliceProof;
    bytes32[] public bobProof;

    function setUp() public {
        startTimestamp = block.timestamp + 1 days;
        token = new MockToken();

        // Double-hash leaf node calculation matching contract
        aliceLeaf = keccak256(bytes.concat(keccak256(abi.encode(alice, ALICE_ALLOCATION, ALICE_DURATION))));
        bobLeaf   = keccak256(bytes.concat(keccak256(abi.encode(bob, BOB_ALLOCATION, BOB_DURATION))));

        // Build 2-leaf Merkle Tree root & proofs
        if (uint256(aliceLeaf) <= uint256(bobLeaf)) {
            merkleRoot = keccak256(bytes.concat(aliceLeaf, bobLeaf));
            aliceProof.push(bobLeaf);
            bobProof.push(aliceLeaf);
        } else {
            merkleRoot = keccak256(bytes.concat(bobLeaf, aliceLeaf));
            aliceProof.push(bobLeaf);
            bobProof.push(aliceLeaf);
        }

        vesting = new MerkleVesting(address(token), merkleRoot, startTimestamp);

        // Fund vesting contract with tokens
        token.transfer(address(vesting), 10_000_000 * 1e18);
    }

    function test_RevertWhen_ConstructorZeroAddressToken() public {
        vm.expectRevert(MerkleVesting.ZeroAddress.selector);
        new MerkleVesting(address(0), merkleRoot, startTimestamp);
    }

    function test_CannotClaimBeforeStart() public {
        vm.expectRevert(MerkleVesting.NothingToClaim.selector);
        vesting.claim(alice, ALICE_ALLOCATION, ALICE_DURATION, aliceProof);
    }

    function test_InvalidProofRejects() public {
        vm.warp(startTimestamp + 100 days);
        bytes32[] memory fakeProof = new bytes32[](1);
        fakeProof[0] = bytes32(uint256(0x99999));

        vm.expectRevert(MerkleVesting.InvalidProof.selector);
        vesting.claim(alice, ALICE_ALLOCATION, ALICE_DURATION, fakeProof);
    }

    function test_LinearVestingProgression25Percent() public {
        // Warp to 25% of Alice's vesting duration
        uint256 elapsedTime = ALICE_DURATION / 4;
        vm.warp(startTimestamp + elapsedTime);

        uint256 claimable = vesting.getClaimableAmount(alice, ALICE_ALLOCATION, ALICE_DURATION);
        uint256 expectedVested = (ALICE_ALLOCATION * elapsedTime) / ALICE_DURATION;
        assertEq(claimable, expectedVested);

        uint256 balanceBefore = token.balanceOf(alice);
        vesting.claim(alice, ALICE_ALLOCATION, ALICE_DURATION, aliceProof);
        uint256 balanceAfter = token.balanceOf(alice);

        assertEq(balanceAfter - balanceBefore, expectedVested);
        assertEq(vesting.claimed(alice), expectedVested);
    }

    function test_IncrementalClaimsOverTime() public {
        // Claim at 25% time
        vm.warp(startTimestamp + (ALICE_DURATION / 4));
        vesting.claim(alice, ALICE_ALLOCATION, ALICE_DURATION, aliceProof);
        uint256 claimed1 = vesting.claimed(alice);

        // Claim again at 50% time
        vm.warp(startTimestamp + (ALICE_DURATION / 2));
        vesting.claim(alice, ALICE_ALLOCATION, ALICE_DURATION, aliceProof);
        uint256 claimed2 = vesting.claimed(alice);

        assertTrue(claimed2 > claimed1);
        assertEq(claimed2, ALICE_ALLOCATION / 2);
    }

    function test_FullVestingAfterDurationExpiry() public {
        vm.warp(startTimestamp + ALICE_DURATION + 10 days);

        vesting.claim(alice, ALICE_ALLOCATION, ALICE_DURATION, aliceProof);
        assertEq(token.balanceOf(alice), ALICE_ALLOCATION);
        assertEq(vesting.claimed(alice), ALICE_ALLOCATION);

        // Cannot claim more after 100% claimed
        vm.expectRevert(MerkleVesting.NothingToClaim.selector);
        vesting.claim(alice, ALICE_ALLOCATION, ALICE_DURATION, aliceProof);
    }

    function test_PrecisionLossSmoothHandling() public {
        // Test precision loss across small time increments (e.g. 1 second elapsed)
        vm.warp(startTimestamp + 1 seconds);

        uint256 vested = vesting.calculateVestedAmount(1_000_000 * 1e18, 365 days, startTimestamp + 1 seconds);
        // (1_000_000 * 1e18 * 1) / 31536000 = 31709791983764
        assertTrue(vested > 0);
    }
}
