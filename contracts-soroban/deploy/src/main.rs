//! Deployment script for GuildPass MembershipNFT Soroban contract.
//!
//! Usage (via cargo-soroban after building the .wasm):
//!   soroban contract deploy \
//!     --wasm ../membership-nft/target/wasm32-unknown-unknown/release/guildpass_membership_nft.wasm \
//!     --source <ADMIN_SECRET> \
//!     --network testnet
//!
//! Then initialize:
//!   soroban contract invoke \
//!     --id <CONTRACT_ID> \
//!     --source <ADMIN_SECRET> \
//!     --network testnet \
//!     -- initialize \
//!       --name "GuildPass Membership" \
//!       --symbol "GPM" \
//!       --base_token_uri "https://guildpass.example.com/metadata/"

use clap::Parser;
use std::process::Command;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Stellar network: testnet | futurenet | mainnet | custom
    #[arg(long, default_value = "testnet")]
    network: String,

    /// Path to the compiled .wasm
    #[arg(long, default_value = "../membership-nft/target/wasm32-unknown-unknown/release/guildpass_membership_nft.wasm")]
    wasm: String,

    /// Base token URI for token metadata
    #[arg(long, default_value = "https://guildpass.example.com/metadata/")]
    base_token_uri: String,

    /// Contract display name (accepted but not stored on-chain)
    #[arg(long, default_value = "GuildPass Membership")]
    name: String,

    /// Contract display symbol (accepted but not stored on-chain)
    #[arg(long, default_value = "GPM")]
    symbol: String,
}

fn main() {
    let args = Args::parse();

    println!("=== GuildPass MembershipNFT Deployment ===");
    println!("Network       : {}", args.network);
    println!("WASM          : {}", args.wasm);
    println!("Base URI      : {}", args.base_token_uri);
    println!("Name          : {}", args.name);
    println!("Symbol        : {}", args.symbol);
    println!();
    println!("Step 1: Build the contract WASM");
    println!("  (cd ../membership-nft && cargo build --target wasm32-unknown-unknown --release)");
    println!();
    println!("Step 2: Deploy (requires soroban CLI and source secret):");
    println!("  soroban contract deploy \\\n    --wasm {} \\\n    --source <ADMIN_SECRET> \\\n    --network {}", args.wasm, args.network);
    println!();
    println!("Step 3: Initialize the deployed contract:");
    println!("  soroban contract invoke \\\n    --id <CONTRACT_ID> \\\n    --source <ADMIN_SECRET> \\\n    --network {} \\\n    -- initialize \\\n      --name \"{}\" \\\n      --symbol \"{}\" \\\n      --base_token_uri \"{}\"", args.network, args.name, args.symbol, args.base_token_uri);
    println!();
    println!("Step 4: Grant an admin:");
    println!("  soroban contract invoke \\\n    --id <CONTRACT_ID> \\\n    --source <OWNER_SECRET> \\\n    --network {} \\\n    -- set_admin --who <ADMIN_ADDRESS> --enabled true", args.network);
}
