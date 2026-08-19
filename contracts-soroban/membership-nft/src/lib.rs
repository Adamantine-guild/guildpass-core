#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, Address,
    BytesN, Env, String as SorobanString, Vec,
};

mod bitmap;

use bitmap::{
    leaf_hash, verify_proof, StorageKey, TokenInfo, IERC165, IERC5192, IERC721,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    NotOwner = 1,
    NotAdmin = 2,
    InvalidAdmin = 3,
    InvalidOwner = 4,
    NotPendingOwner = 5,
    InvalidTo = 6,
    InvalidDuration = 7,
    NoToken = 8,
    InvalidRoot = 9,
    NoRootSet = 10,
    InvalidWallet = 11,
    ExpiryInPast = 12,
    AlreadyClaimed = 13,
    InvalidProof = 14,
    ExpiryNotLater = 15,
    ZeroAddress = 16,
    NotInitialized = 17,
}

#[contract]
pub struct MembershipNFT;

fn is_valid_address(addr: &Address) -> bool {
    let bytes: Result<[u8; 32], _> = addr.clone().try_into();
    match bytes {
        Ok(b) => b.iter().any(|&x| x != 0),
        Err(_) => false,
    }
}

fn require_owner(e: &Env) -> Result<(), ContractError> {
    let caller = e.caller();
    let owner: Address = e
        .storage()
        .instance()
        .get(&StorageKey::Owner)
        .ok_or(ContractError::NotInitialized)?;
    if caller != owner {
        Err(ContractError::NotOwner)
    } else {
        Ok(())
    }
}

fn require_admin(e: &Env) -> Result<(), ContractError> {
    let caller = e.caller();
    let is_admin: bool = e
        .storage()
        .instance()
        .get(&StorageKey::Admin(caller.clone()))
        .unwrap_or(false);
    if !is_admin {
        Err(ContractError::NotAdmin)
    } else {
        Ok(())
    }
}

fn next_token_id(e: &Env) -> u128 {
    let current: u128 = e.storage().instance().get(&StorageKey::NextTokenId).unwrap_or(1);
    e.storage().instance().set(&StorageKey::NextTokenId, &(current + 1));
    current
}

fn peek_next_token_id(e: &Env) -> u128 {
    e.storage().instance().get(&StorageKey::NextTokenId).unwrap_or(1)
}

fn get_token_info_or_err(e: &Env, token_id: u128) -> Result<TokenInfo, ContractError> {
    e.storage()
        .instance()
        .get(&StorageKey::TokenInfo(token_id))
        .ok_or(ContractError::NoToken)
}

fn set_token_info(e: &Env, token_id: u128, info: &TokenInfo) {
    e.storage().instance().set(&StorageKey::TokenInfo(token_id), info);
}

fn get_active_token(e: &Env, wallet: &Address, community: &SorobanString) -> u128 {
    e.storage()
        .instance()
        .get(&StorageKey::ActiveToken {
            wallet: wallet.clone(),
            community: community.clone(),
        })
        .unwrap_or(0)
}

fn set_active_token(e: &Env, wallet: &Address, community: &SorobanString, token_id: u128) {
    if token_id == 0 {
        e.storage().instance().remove(&StorageKey::ActiveToken {
            wallet: wallet.clone(),
            community: community.clone(),
        });
    } else {
        e.storage().instance().set(
            &StorageKey::ActiveToken {
                wallet: wallet.clone(),
                community: community.clone(),
            },
            &token_id,
        );
    }
}

fn get_balance(e: &Env, wallet: &Address) -> u128 {
    e.storage()
        .instance()
        .get(&StorageKey::Balance(wallet.clone()))
        .unwrap_or(0)
}

fn set_balance(e: &Env, wallet: &Address, balance: u128) {
    e.storage().instance().set(&StorageKey::Balance(wallet.clone()), &balance);
}

fn get_owned_tokens(e: &Env, wallet: &Address) -> Vec<u128> {
    e.storage()
        .instance()
        .get(&StorageKey::OwnedTokens(wallet.clone()))
        .unwrap_or(Vec::new(e))
}

fn set_owned_tokens(e: &Env, wallet: &Address, tokens: &Vec<u128>) {
    if tokens.is_empty() {
        e.storage().instance().remove(&StorageKey::OwnedTokens(wallet.clone()));
    } else {
        e.storage()
            .instance()
            .set(&StorageKey::OwnedTokens(wallet.clone()), tokens);
    }
}

fn remove_owned_token(e: &Env, owner: &Address, token_id: u128) {
    let mut tokens = get_owned_tokens(e, owner);
    let mut found_idx: Option<u32> = None;
    for (i, t) in tokens.iter().enumerate() {
        if t == token_id {
            found_idx = Some(i as u32);
            break;
        }
    }
    if let Some(idx) = found_idx {
        let last = tokens.last().unwrap();
        tokens.set(idx, &last);
        tokens.pop_back();
        set_owned_tokens(e, owner, &tokens);
    }
}

fn push_owned_token(e: &Env, owner: &Address, token_id: u128) {
    let mut tokens = get_owned_tokens(e, owner);
    tokens.push_back(token_id);
    set_owned_tokens(e, owner, &tokens);
}

fn is_claimed(e: &Env, community: &SorobanString, root: &BytesN<32>, index: u128) -> bool {
    e.storage()
        .instance()
        .get(&StorageKey::ClaimedIndex {
            community: community.clone(),
            root: root.clone(),
            index,
        })
        .unwrap_or(false)
}

fn set_claimed(e: &Env, community: &SorobanString, root: &BytesN<32>, index: u128) {
    e.storage().instance().set(
        &StorageKey::ClaimedIndex {
            community: community.clone(),
            root: root.clone(),
            index,
        },
        &true,
    );
}

fn timestamp(e: &Env) -> u64 {
    e.ledger().timestamp()
}

fn uint_to_string(e: &Env, value: u128) -> SorobanString {
    if value == 0 {
        return SorobanString::from_str(e, "0");
    }
    let digits = [b'0', b'1', b'2', b'3', b'4', b'5', b'6', b'7', b'8', b'9'];
    let mut buf: Vec<u8> = Vec::new(e);
    let mut v = value;
    while v > 0 {
        let rem = (v % 10) as usize;
        buf.push_front(digits[rem]);
        v /= 10;
    }
    SorobanString::from_utf8(e, &buf)
}

fn emit_transfer(e: &Env, from: Option<Address>, to: Option<Address>, token_id: u128) {
    let from_topic: Option<Address> = from;
    let to_topic: Option<Address> = to;
    e.events().publish(
        (SorobanString::from_str(e, "Transfer"), from_topic, to_topic, token_id),
        (),
    );
}

fn emit_locked(e: &Env, token_id: u128) {
    e.events()
        .publish((SorobanString::from_str(e, "Locked"), token_id), ());
}

fn emit_unlocked(e: &Env, token_id: u128) {
    e.events()
        .publish((SorobanString::from_str(e, "Unlocked"), token_id), ());
}

fn emit_membership_minted(
    e: &Env,
    to: &Address,
    token_id: u128,
    community: &SorobanString,
    expires_at: u64,
) {
    e.events().publish(
        (
            SorobanString::from_str(e, "MembershipMinted"),
            to.clone(),
            token_id,
        ),
        (community.clone(), expires_at),
    );
}

fn emit_membership_renewed(e: &Env, token_id: u128, new_expires_at: u64) {
    e.events().publish(
        (SorobanString::from_str(e, "MembershipRenewed"), token_id),
        new_expires_at,
    );
}

fn emit_membership_suspended(e: &Env, token_id: u128, is_suspended: bool) {
    e.events().publish(
        (SorobanString::from_str(e, "MembershipSuspended"), token_id),
        is_suspended,
    );
}

fn emit_admin_updated(e: &Env, admin: &Address, enabled: bool) {
    e.events().publish(
        (SorobanString::from_str(e, "AdminUpdated"), admin.clone()),
        enabled,
    );
}

fn emit_ownership_transfer_proposed(e: &Env, current: &Address, proposed: &Address) {
    e.events().publish(
        (
            SorobanString::from_str(e, "OwnershipTransferProposed"),
            current.clone(),
            proposed.clone(),
        ),
        (),
    );
}

fn emit_ownership_transferred(e: &Env, prev: &Address, new: &Address) {
    e.events().publish(
        (
            SorobanString::from_str(e, "OwnershipTransferred"),
            prev.clone(),
            new.clone(),
        ),
        (),
    );
}

fn emit_merkle_root_updated(
    e: &Env,
    community: &SorobanString,
    prev_root: &BytesN<32>,
    new_root: &BytesN<32>,
) {
    e.events().publish(
        (SorobanString::from_str(e, "MembershipMerkleRootUpdated"),),
        (community.clone(), prev_root.clone(), new_root.clone()),
    );
}

fn emit_membership_claimed(
    e: &Env,
    wallet: &Address,
    token_id: u128,
    community: &SorobanString,
    index: u128,
    expires_at: u64,
) {
    e.events().publish(
        (
            SorobanString::from_str(e, "MembershipClaimed"),
            wallet.clone(),
            token_id,
        ),
        (community.clone(), index, expires_at),
    );
}

fn zero_bytes32(e: &Env) -> BytesN<32> {
    BytesN::from_array(e, &[0u8; 32])
}

#[contractimpl]
impl MembershipNFT {
    pub fn initialize(
        e: Env,
        _name: SorobanString,
        _symbol: SorobanString,
        base_token_uri: SorobanString,
    ) -> Result<(), ContractError> {
        if e.storage().instance().has(&StorageKey::Owner) {
            return Ok(());
        }
        let deployer = e.invoker();
        e.storage().instance().set(&StorageKey::Owner, &deployer);
        e.storage().instance().set(&StorageKey::NextTokenId, &1u128);
        e.storage().instance().set(&StorageKey::BaseTokenURI, &base_token_uri);
        Ok(())
    }

    pub fn owner(e: Env) -> Result<Address, ContractError> {
        e.storage()
            .instance()
            .get(&StorageKey::Owner)
            .ok_or(ContractError::NotInitialized)
    }

    pub fn pending_owner(e: Env) -> Option<Address> {
        e.storage().instance().get(&StorageKey::PendingOwner)
    }

    pub fn admins(e: Env, who: Address) -> bool {
        e.storage()
            .instance()
            .get(&StorageKey::Admin(who))
            .unwrap_or(false)
    }

    pub fn set_admin(e: Env, who: Address, enabled: bool) -> Result<(), ContractError> {
        let caller = e.caller();
        let owner: Address = e
            .storage()
            .instance()
            .get(&StorageKey::Owner)
            .ok_or(ContractError::NotInitialized)?;
        if caller != owner {
            return Err(ContractError::NotOwner);
        }
        if !is_valid_address(&who) {
            return Err(ContractError::InvalidAdmin);
        }
        e.storage().instance().set(&StorageKey::Admin(who.clone()), &enabled);
        emit_admin_updated(&e, &who, enabled);
        Ok(())
    }

    pub fn transfer_ownership(e: Env, proposed_owner: Address) -> Result<(), ContractError> {
        require_owner(&e)?;
        if !is_valid_address(&proposed_owner) {
            return Err(ContractError::InvalidOwner);
        }
        let current: Address = e.storage().instance().get(&StorageKey::Owner).unwrap();
        e.storage()
            .instance()
            .set(&StorageKey::PendingOwner, &proposed_owner);
        emit_ownership_transfer_proposed(&e, &current, &proposed_owner);
        Ok(())
    }

    pub fn accept_ownership(e: Env) -> Result<(), ContractError> {
        let caller = e.caller();
        let pending: Address = e
            .storage()
            .instance()
            .get(&StorageKey::PendingOwner)
            .ok_or(ContractError::NotPendingOwner)?;
        if caller != pending {
            return Err(ContractError::NotPendingOwner);
        }
        let previous: Address = e.storage().instance().get(&StorageKey::Owner).unwrap();
        e.storage().instance().set(&StorageKey::Owner, &caller);
        e.storage().instance().remove(&StorageKey::PendingOwner);
        emit_ownership_transferred(&e, &previous, &caller);
        Ok(())
    }

    pub fn mint(
        e: Env,
        to: Address,
        community_id: SorobanString,
        duration: u64,
    ) -> Result<u128, ContractError> {
        require_admin(&e)?;
        if !is_valid_address(&to) {
            return Err(ContractError::InvalidTo);
        }
        if duration == 0 {
            return Err(ContractError::InvalidDuration);
        }

        let previous_token_id = get_active_token(&e, &to, &community_id);
        if previous_token_id != 0 {
            let prev_info = get_token_info_or_err(&e, previous_token_id)?;
            let block_ts = timestamp(&e);
            if !prev_info.suspended && prev_info.expiry > block_ts {
                let mut updated = prev_info.clone();
                updated.suspended = true;
                set_token_info(&e, previous_token_id, &updated);
                emit_membership_suspended(&e, previous_token_id, true);
                emit_transfer(&e, Some(prev_info.owner.clone()), None, previous_token_id);
                set_balance(&e, &prev_info.owner, get_balance(&e, &prev_info.owner) - 1);
                remove_owned_token(&e, &prev_info.owner, previous_token_id);
            }
        }

        let token_id = next_token_id(&e);
        let block_ts = timestamp(&e);
        let info = TokenInfo {
            owner: to.clone(),
            community: community_id.clone(),
            expiry: block_ts + duration,
            suspended: false,
        };
        set_token_info(&e, token_id, &info);
        set_active_token(&e, &to, &community_id, token_id);
        emit_transfer(&e, None, Some(to.clone()), token_id);
        emit_locked(&e, token_id);
        set_balance(&e, &to, get_balance(&e, &to) + 1);
        push_owned_token(&e, &to, token_id);
        emit_membership_minted(&e, &to, token_id, &community_id, info.expiry);
        Ok(token_id)
    }

    pub fn renew(
        e: Env,
        token_id: u128,
        duration: u64,
    ) -> Result<(), ContractError> {
        require_admin(&e)?;
        if duration == 0 {
            return Err(ContractError::InvalidDuration);
        }
        let mut info = get_token_info_or_err(&e, token_id)?;
        let block_ts = timestamp(&e);
        let current = info.expiry;
        let new_expiry = if current < block_ts {
            block_ts + duration
        } else {
            current + duration
        };
        info.expiry = new_expiry;
        set_token_info(&e, token_id, &info);
        emit_membership_renewed(&e, token_id, new_expiry);
        Ok(())
    }

    pub fn set_suspended(
        e: Env,
        token_id: u128,
        suspended: bool,
    ) -> Result<(), ContractError> {
        require_admin(&e)?;
        let mut info = get_token_info_or_err(&e, token_id)?;
        let block_ts = timestamp(&e);
        let was_active = !info.suspended && info.expiry > block_ts;
        info.suspended = suspended;
        set_token_info(&e, token_id, &info);
        emit_membership_suspended(&e, token_id, suspended);

        if was_active && suspended {
            emit_transfer(&e, Some(info.owner.clone()), None, token_id);
            set_balance(&e, &info.owner, get_balance(&e, &info.owner) - 1);
            remove_owned_token(&e, &info.owner, token_id);
        } else if !was_active && !suspended && info.expiry > block_ts {
            emit_transfer(&e, None, Some(info.owner.clone()), token_id);
            set_balance(&e, &info.owner, get_balance(&e, &info.owner) + 1);
            push_owned_token(&e, &info.owner, token_id);
        }
        Ok(())
    }

    pub fn set_membership_merkle_root(
        e: Env,
        community_id: SorobanString,
        root: BytesN<32>,
    ) -> Result<(), ContractError> {
        require_admin(&e)?;
        let zero = zero_bytes32(&e);
        if root == zero {
            return Err(ContractError::InvalidRoot);
        }
        let previous_root: BytesN<32> = e
            .storage()
            .instance()
            .get(&StorageKey::MerkleRoot(community_id.clone()))
            .unwrap_or(zero.clone());
        e.storage()
            .instance()
            .set(&StorageKey::MerkleRoot(community_id.clone()), &root);
        emit_merkle_root_updated(&e, &community_id, &previous_root, &root);
        Ok(())
    }

    pub fn claim_membership(
        e: Env,
        community_id: SorobanString,
        index: u128,
        wallet: Address,
        expires_at: u64,
        proof: Vec<BytesN<32>>,
    ) -> Result<u128, ContractError> {
        let root: BytesN<32> = e
            .storage()
            .instance()
            .get(&StorageKey::MerkleRoot(community_id.clone()))
            .ok_or(ContractError::NoRootSet)?;
        let zero = zero_bytes32(&e);
        if root == zero {
            return Err(ContractError::NoRootSet);
        }
        if !is_valid_address(&wallet) {
            return Err(ContractError::InvalidWallet);
        }
        let block_ts = timestamp(&e);
        if expires_at <= block_ts {
            return Err(ContractError::ExpiryInPast);
        }
        if is_claimed(&e, &community_id, &root, index) {
            return Err(ContractError::AlreadyClaimed);
        }
        let leaf = leaf_hash(&e, index, &wallet, &community_id, expires_at);
        if !verify_proof(&e, &proof, &root, &leaf) {
            return Err(ContractError::InvalidProof);
        }

        let existing_token_id = get_active_token(&e, &wallet, &community_id);
        let token_id: u128;

        if existing_token_id == 0 {
            token_id = next_token_id(&e);
            let info = TokenInfo {
                owner: wallet.clone(),
                community: community_id.clone(),
                expiry: expires_at,
                suspended: false,
            };
            set_token_info(&e, token_id, &info);
            set_active_token(&e, &wallet, &community_id, token_id);
            set_claimed(&e, &community_id, &root, index);
            emit_transfer(&e, None, Some(wallet.clone()), token_id);
            emit_locked(&e, token_id);
            set_balance(&e, &wallet, get_balance(&e, &wallet) + 1);
            push_owned_token(&e, &wallet, token_id);
            emit_membership_minted(&e, &wallet, token_id, &community_id, expires_at);
        } else {
            let mut info = get_token_info_or_err(&e, existing_token_id)?;
            if expires_at <= info.expiry {
                return Err(ContractError::ExpiryNotLater);
            }
            token_id = existing_token_id;
            info.expiry = expires_at;
            set_token_info(&e, token_id, &info);
            set_claimed(&e, &community_id, &root, index);
            emit_membership_renewed(&e, token_id, expires_at);
        }

        emit_membership_claimed(&e, &wallet, token_id, &community_id, index, expires_at);
        Ok(token_id)
    }

    pub fn is_claimed(
        e: Env,
        community_id: SorobanString,
        root: BytesN<32>,
        index: u128,
    ) -> bool {
        is_claimed(&e, &community_id, &root, index)
    }

    pub fn is_active(e: Env, token_id: u128) -> bool {
        match e.storage().instance().get::<_, TokenInfo>(&StorageKey::TokenInfo(token_id)) {
            Some(info) => {
                if info.suspended {
                    return false;
                }
                let block_ts = timestamp(&e);
                info.expiry > block_ts
            }
            None => false,
        }
    }

    pub fn owner_of(e: Env, token_id: u128) -> Result<Address, ContractError> {
        let info = get_token_info_or_err(&e, token_id)?;
        Ok(info.owner)
    }

    pub fn community_of(e: Env, token_id: u128) -> Result<SorobanString, ContractError> {
        let info = get_token_info_or_err(&e, token_id)?;
        Ok(info.community)
    }

    pub fn suspended(e: Env, token_id: u128) -> Result<bool, ContractError> {
        let info = get_token_info_or_err(&e, token_id)?;
        Ok(info.suspended)
    }

    pub fn expiry(e: Env, token_id: u128) -> Result<u64, ContractError> {
        let info = get_token_info_or_err(&e, token_id)?;
        Ok(info.expiry)
    }

    pub fn active_token_of(e: Env, wallet: Address, community_id: SorobanString) -> u128 {
        get_active_token(&e, &wallet, &community_id)
    }

    pub fn supports_interface(_e: Env, interface_id: u32) -> bool {
        interface_id == IERC165
            || interface_id == IERC721
            || interface_id == IERC5192
    }

    pub fn balance_of(e: Env, account: Address) -> Result<u128, ContractError> {
        if !is_valid_address(&account) {
            return Err(ContractError::ZeroAddress);
        }
        Ok(get_balance(&e, &account))
    }

    pub fn token_uri(e: Env, token_id: u128) -> Result<SorobanString, ContractError> {
        get_token_info_or_err(&e, token_id)?;
        let base: SorobanString = e
            .storage()
            .instance()
            .get(&StorageKey::BaseTokenURI)
            .unwrap_or(SorobanString::from_str(&e, ""));
        let id_str = uint_to_string(&e, token_id);
        let mut buf: Vec<u8> = Vec::new(&e);
        for b in base.to_bytes().iter() {
            buf.push_back(b);
        }
        for b in id_str.to_bytes().iter() {
            buf.push_back(b);
        }
        Ok(SorobanString::from_utf8(&e, &buf))
    }

    pub fn locked(e: Env, token_id: u128) -> Result<bool, ContractError> {
        get_token_info_or_err(&e, token_id)?;
        Ok(true)
    }

    pub fn base_token_uri(e: Env) -> SorobanString {
        e.storage()
            .instance()
            .get(&StorageKey::BaseTokenURI)
            .unwrap_or(SorobanString::from_str(&e, ""))
    }

    pub fn merkle_root(e: Env, community_id: SorobanString) -> BytesN<32> {
        e.storage()
            .instance()
            .get(&StorageKey::MerkleRoot(community_id))
            .unwrap_or(zero_bytes32(&e))
    }
}

#[cfg(test)]
mod test;
