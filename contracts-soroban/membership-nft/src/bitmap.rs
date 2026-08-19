use soroban_sdk::{
    contracttype, Address, BytesN, Env, String as SorobanString, Vec,
};

#[contracttype]
#[derive(Clone)]
pub struct TokenInfo {
    pub owner: Address,
    pub community: SorobanString,
    pub expiry: u64,
    pub suspended: bool,
}

#[contracttype]
#[derive(Clone, PartialEq, Eq)]
pub enum StorageKey {
    NextTokenId,
    Owner,
    PendingOwner,
    Admin(Address),
    TokenInfo(u128),
    ActiveToken {
        wallet: Address,
        community: SorobanString,
    },
    Balance(Address),
    OwnedTokens(Address),
    MerkleRoot(SorobanString),
    ClaimedIndex {
        community: SorobanString,
        root: BytesN<32>,
        index: u128,
    },
    BaseTokenURI,
}

pub const IERC165: u32 = 0x01ffc9a7;
pub const IERC721: u32 = 0x80ac58cd;
pub const IERC5192: u32 = 0x4bc2a65b;

pub const ERROR_NOT_OWNER: &str = "NOT_OWNER";
pub const ERROR_NOT_ADMIN: &str = "NOT_ADMIN";
pub const ERROR_INVALID_ADMIN: &str = "INVALID_ADMIN";
pub const ERROR_INVALID_OWNER: &str = "INVALID_OWNER";
pub const ERROR_NOT_PENDING_OWNER: &str = "NOT_PENDING_OWNER";
pub const ERROR_INVALID_TO: &str = "INVALID_TO";
pub const ERROR_INVALID_DURATION: &str = "INVALID_DURATION";
pub const ERROR_NO_TOKEN: &str = "NO_TOKEN";
pub const ERROR_INVALID_ROOT: &str = "INVALID_ROOT";
pub const ERROR_NO_ROOT_SET: &str = "NO_ROOT_SET";
pub const ERROR_INVALID_WALLET: &str = "INVALID_WALLET";
pub const ERROR_EXPIRY_IN_PAST: &str = "EXPIRY_IN_PAST";
pub const ERROR_ALREADY_CLAIMED: &str = "ALREADY_CLAIMED";
pub const ERROR_INVALID_PROOF: &str = "INVALID_PROOF";
pub const ERROR_EXPIRY_NOT_LATER: &str = "EXPIRY_NOT_LATER";
pub const ERROR_ZERO_ADDRESS: &str = "ZERO_ADDRESS";

pub fn hash_pair(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let a_bytes: [u8; 32] = a.clone().into();
    let b_bytes: [u8; 32] = b.clone().into();
    let mut combined = [0u8; 64];
    if a_bytes <= b_bytes {
        combined[..32].copy_from_slice(&a_bytes);
        combined[32..].copy_from_slice(&b_bytes);
    } else {
        combined[..32].copy_from_slice(&b_bytes);
        combined[32..].copy_from_slice(&a_bytes);
    }
    env.crypto().keccak256(&BytesN::<64>::from_array(env, &combined))
}

pub fn leaf_hash(
    env: &Env,
    index: u128,
    wallet: &Address,
    community: &SorobanString,
    expires_at: u64,
) -> BytesN<32> {
    let mut preimage: Vec<u8> = Vec::new(env);
    for b in index.to_be_bytes().iter() {
        preimage.push_back(*b);
    }
    let wallet_bytes: [u8; 32] = wallet.clone().try_into().unwrap();
    for b in wallet_bytes.iter() {
        preimage.push_back(*b);
    }
    let community_bytes = community.to_bytes();
    let community_len: u32 = community_bytes.len() as u32;
    for b in community_len.to_be_bytes().iter() {
        preimage.push_back(*b);
    }
    for b in community_bytes.iter() {
        preimage.push_back(*b);
    }
    for b in expires_at.to_be_bytes().iter() {
        preimage.push_back(*b);
    }
    let inner = env.crypto().keccak256(&preimage);

    let mut outer_preimage: Vec<u8> = Vec::new(env);
    let inner_bytes: [u8; 32] = inner.clone().into();
    for b in inner_bytes.iter() {
        outer_preimage.push_back(*b);
    }
    env.crypto().keccak256(&outer_preimage)
}

pub fn verify_proof(
    env: &Env,
    proof: &Vec<BytesN<32>>,
    root: &BytesN<32>,
    leaf: &BytesN<32>,
) -> bool {
    let mut current = leaf.clone();
    for sibling in proof.iter() {
        current = hash_pair(env, &current, &sibling);
    }
    current == *root
}
