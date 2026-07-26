// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Script.sol";
import "../src/MembershipNFT.sol";

contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        MembershipNFT nft = new MembershipNFT("GuildPass Membership", "GPM", "https://guildpass.example.com/metadata/");
        console2.log("MembershipNFT deployed at", address(nft));
        vm.stopBroadcast();
    }
}
