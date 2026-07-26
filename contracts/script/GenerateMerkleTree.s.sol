// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Script.sol";
import {MerkleTreeLib} from "./MerkleTreeLib.sol";

/// @notice Off-chain (well, off-transaction: it still runs through forge, but
/// performs no broadcast) tooling that turns a per-community allowlist into a
/// Merkle root plus one proof per wallet, ready to be published via
/// MembershipNFT.setMembershipMerkleRoot and consumed via claimMembership.
///
/// Usage:
///   forge script contracts/script/GenerateMerkleTree.s.sol
///     [--sig "run()"]
///     MERKLE_INPUT=path/to/input.json MERKLE_OUTPUT=path/to/output.json
///
/// If MERKLE_INPUT/MERKLE_OUTPUT are not set, the bundled sample fixture at
/// contracts/script/fixtures/sample-allowlist.json is used, writing to
/// contracts/script/fixtures/sample-allowlist.out.json - this is also what
/// contracts/test/GenerateMerkleTreeFixture.t.sol consumes to prove the
/// generator's real output claims successfully on-chain.
///
/// Input format (JSON):
///   {
///     "communityId": "<string, matches MembershipNFT's communityId exactly>",
///     "entries": [
///       { "expiresAt": <absolute unix timestamp>, "wallet": "0x..." },
///       ...
///     ]
///   }
/// (Object keys per entry MUST be alphabetically ordered - "expiresAt" before
/// "wallet" - because Foundry's vm.parseJson decodes a JSON object array into
/// a Solidity struct by zipping keys in alphabetical order against the
/// struct's declared field order, not the order keys happen to appear in the
/// source file.)
///
/// Output format (JSON):
///   {
///     "communityId": "...",
///     "root": "0x...",
///     "claims": [
///       { "index": 0, "wallet": "0x...", "expiresAt": ..., "proof": ["0x...", ...] },
///       ...
///     ]
///   }
/// `root` is what an admin passes to setMembershipMerkleRoot. Each `claims[]`
/// entry is exactly the argument tuple (communityId, index, wallet,
/// expiresAt, proof) a wallet or relayer passes to claimMembership.
///
/// DETERMINISM: entries are sorted by wallet address ascending (numeric value
/// of the address) before `index` is assigned. This is the sort key. It is
/// chosen so that regenerating from the same underlying (wallet, expiresAt)
/// set always produces a byte-identical root and proof set regardless of the
/// order entries happened to appear in the input file (e.g. if the input was
/// re-exported from a database with unstable row ordering). Two entries with
/// the same wallet address for one communityId are a data error and the run
/// reverts rather than silently picking one.
///
/// VERIFYING A ROOT BEFORE PUBLISHING: re-run the generator against the same
/// input and confirm the `root` field is unchanged (see the determinism test
/// in GenerateMerkleTreeFixture.t.sol for an automated version of this
/// check); independently, an admin can spot-check any single claims[] entry
/// by calling MerkleProof.verify(proof, root, leafHash(index, wallet,
/// communityId, expiresAt)) - or simply attempt the claim on a fork - before
/// calling setMembershipMerkleRoot on mainnet.
contract GenerateMerkleTree is Script {
    /// @dev Field order MUST be alphabetical (expiresAt, wallet) to match how
    /// vm.parseJson decodes a JSON object into this struct - see the file-level
    /// NatSpec above.
    struct EntryJson {
        uint256 expiresAt;
        address wallet;
    }

    function run() external {
        string memory inputPath =
            vm.envOr("MERKLE_INPUT", string("contracts/script/fixtures/sample-allowlist.json"));
        string memory outputPath = vm.envOr(
            "MERKLE_OUTPUT", string("contracts/script/fixtures/sample-allowlist.out.json")
        );
        generateToFile(inputPath, outputPath);
    }

    /// @notice Reads `inputPath`, builds the tree, writes `outputPath`. Public
    /// (not just internal to run()) so a test can invoke the exact same
    /// file-I/O path the CLI tool uses, rather than a parallel code path.
    function generateToFile(string memory inputPath, string memory outputPath) public {
        string memory json = vm.readFile(inputPath);
        string memory communityId = vm.parseJsonString(json, ".communityId");
        EntryJson[] memory rawEntries = abi.decode(vm.parseJson(json, ".entries"), (EntryJson[]));
        require(rawEntries.length > 0, "GenerateMerkleTree: empty entries list");

        (address[] memory wallets, uint256[] memory expiresAts) = _sortByWallet(rawEntries);
        _requireNoDuplicateWallets(wallets);

        uint256 n = wallets.length;
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            leaves[i] = MerkleTreeLib.leafHash(i, wallets[i], communityId, expiresAts[i]);
        }
        bytes32[][] memory levels = MerkleTreeLib.buildLevels(leaves);
        bytes32 root = MerkleTreeLib.root(levels);

        vm.writeFile(outputPath, _buildOutputJson(communityId, root, wallets, expiresAts, levels));

        console2.log("communityId:", communityId);
        console2.log("entries:", n);
        console2.logBytes32(root);
        console2.log("written to:", outputPath);
    }

    /// @dev Deterministic sort by ascending wallet address (see file-level
    /// NatSpec). Insertion sort: entry counts here are allowlist batch sizes
    /// (hundreds to low thousands), and this runs off-chain in a script, so
    /// O(n^2) is a fine trade for a ~10-line, easy-to-audit implementation.
    function _sortByWallet(EntryJson[] memory raw)
        internal
        pure
        returns (address[] memory wallets, uint256[] memory expiresAts)
    {
        uint256 n = raw.length;
        wallets = new address[](n);
        expiresAts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            wallets[i] = raw[i].wallet;
            expiresAts[i] = raw[i].expiresAt;
        }
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

    function _requireNoDuplicateWallets(address[] memory sortedWallets) internal pure {
        for (uint256 i = 1; i < sortedWallets.length; i++) {
            require(
                sortedWallets[i] != sortedWallets[i - 1],
                "GenerateMerkleTree: duplicate wallet for this communityId"
            );
        }
    }

    function _buildOutputJson(
        string memory communityId,
        bytes32 root,
        address[] memory wallets,
        uint256[] memory expiresAts,
        bytes32[][] memory levels
    ) internal returns (string memory) {
        uint256 n = wallets.length;
        string memory claims = "";
        for (uint256 i = 0; i < n; i++) {
            bytes32[] memory proof = MerkleTreeLib.proofFor(levels, i);
            claims = string.concat(
                claims, i == 0 ? "" : ",", _claimJson(i, wallets[i], expiresAts[i], proof)
            );
        }
        return string.concat(
            "{\"communityId\":\"",
            communityId,
            "\",\"root\":\"",
            vm.toString(root),
            "\",\"claims\":[",
            claims,
            "]}"
        );
    }

    function _claimJson(uint256 index, address wallet, uint256 expiresAt, bytes32[] memory proof)
        internal
        returns (string memory)
    {
        string memory proofJson = "";
        for (uint256 i = 0; i < proof.length; i++) {
            proofJson =
                string.concat(proofJson, i == 0 ? "" : ",", "\"", vm.toString(proof[i]), "\"");
        }
        return string.concat(
            "{\"index\":",
            vm.toString(index),
            ",\"wallet\":\"",
            vm.toString(wallet),
            "\",\"expiresAt\":",
            vm.toString(expiresAt),
            ",\"proof\":[",
            proofJson,
            "]}"
        );
    }
}
