// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import {MembershipNFT} from "../src/MembershipNFT.sol";
import {MerkleTreeLib} from "../script/MerkleTreeLib.sol";

/// @notice Gas benchmark for issue #102: admin-side cost of the existing
/// per-wallet mint/renew path vs. the new Merkle batch-claim path, at
/// representative allowlist sizes (N = 100, 500, 1000). This is a
/// measurement, not a correctness assertion - run with
/// `forge test --match-path contracts/test/GasBenchmark.t.sol -vv`
/// to see the logged breakdown feeding the PR's gas comparison table.
contract GasBenchmarkTest is Test {
    address admin = address(0xA11CE);
    string constant COMMUNITY = "gas-benchmark-community";

    function testGasBenchmark_N100() public {
        _run(100);
    }

    function testGasBenchmark_N500() public {
        _run(500);
    }

    function testGasBenchmark_N1000() public {
        _run(1000);
    }

    function _run(uint256 n) internal {
        console2.log("=== Gas benchmark, N =", n, "===");
        _benchmarkAdminMint(n);
        _benchmarkAdminRenew(n);
        _benchmarkMerklePath(n);
    }

    function _benchmarkAdminMint(uint256 n) internal {
        MembershipNFT nft = new MembershipNFT("GuildPass Membership", "GPM", "https://guildpass.example.com/metadata/");
        nft.setAdmin(admin, true);

        uint256 gasStart = gasleft();
        for (uint256 i = 0; i < n; i++) {
            address wallet = address(uint160(0x10000 + i));
            vm.prank(admin);
            nft.mint(wallet, COMMUNITY, 365 days);
        }
        uint256 used = gasStart - gasleft();
        console2.log("  admin mint() total gas (N calls):", used);
        console2.log("  admin mint() gas per call        :", used / n);
    }

    function _benchmarkAdminRenew(uint256 n) internal {
        MembershipNFT nft = new MembershipNFT("GuildPass Membership", "GPM", "https://guildpass.example.com/metadata/");
        nft.setAdmin(admin, true);
        uint256[] memory tokenIds = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address wallet = address(uint160(0x20000 + i));
            vm.prank(admin);
            tokenIds[i] = nft.mint(wallet, COMMUNITY, 365 days);
        }

        uint256 gasStart = gasleft();
        for (uint256 i = 0; i < n; i++) {
            vm.prank(admin);
            nft.renew(tokenIds[i], 30 days);
        }
        uint256 used = gasStart - gasleft();
        console2.log("  admin renew() total gas (N calls):", used);
        console2.log("  admin renew() gas per call        :", used / n);
    }

    function _benchmarkMerklePath(uint256 n) internal {
        MembershipNFT nft = new MembershipNFT("GuildPass Membership", "GPM", "https://guildpass.example.com/metadata/");
        nft.setAdmin(admin, true);

        bytes32[] memory leaves = new bytes32[](n);
        address[] memory wallets = new address[](n);
        uint256 expiresAt = block.timestamp + 365 days;
        for (uint256 i = 0; i < n; i++) {
            wallets[i] = address(uint160(0x30000 + i));
            leaves[i] = MerkleTreeLib.leafHash(i, wallets[i], COMMUNITY, expiresAt);
        }
        bytes32[][] memory levels = MerkleTreeLib.buildLevels(leaves);
        bytes32 root = MerkleTreeLib.root(levels);

        uint256 rootGasStart = gasleft();
        vm.prank(admin);
        nft.setMembershipMerkleRoot(COMMUNITY, root);
        uint256 rootGasUsed = rootGasStart - gasleft();
        console2.log("  admin setMembershipMerkleRoot total gas (1 call):", rootGasUsed);

        uint256 claimGasStart = gasleft();
        for (uint256 i = 0; i < n; i++) {
            bytes32[] memory proof = MerkleTreeLib.proofFor(levels, i);
            nft.claimMembership(COMMUNITY, i, wallets[i], expiresAt, proof);
        }
        uint256 claimGasUsed = claimGasStart - gasleft();
        console2.log("  claimer claimMembership total gas (N calls)    :", claimGasUsed);
        console2.log("  claimer claimMembership gas per call           :", claimGasUsed / n);
    }
}
